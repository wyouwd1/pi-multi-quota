/**
 * Ark（火山引擎 Coding Plan）额度适配器。
 *
 * 端点与响应样例见 SPEC.md §2.3，错误码取值见 tasks/TEAM-SYNC.md §1.3。
 * Ark 特例：**鉴权失败时 HTTP 仍是 200**，失败信息在 body 的 `ResponseMetadata.Error.Code` 里，
 * 只看状态码会把失败误判成成功。
 * 零运行时依赖；网络调用经 `fetchImpl` 注入；不写日志，error.message 只含中文短句、不回显凭据与响应体。
 */
import { parseArkCookie } from "../cookie.js";
import { redact } from "../config.js";
import type { ArkAccountConfig } from "../config.js";
import type { FetchOptions } from "./opencode.js";
import type { AccountReport, QuotaWindow, WindowLevel } from "../types.js";

/** Ark Coding Plan 用量端点。 */
export const ARK_USAGE_URL =
  "https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage?";

/** 唯一允许携带凭据的 host（SPEC §6）。 */
export const ARK_ALLOWED_HOST = "console.volcengine.com";

/** 默认超时，与 src/sources/opencode.ts 一致。 */
const DEFAULT_TIMEOUT_MS = 20000;

/** 响应 Level → 内部窗口粒度；表外的 Level 视为接口变更：跳过并记 note。 */
const LEVELS: ReadonlyMap<string, WindowLevel> = new Map<string, WindowLevel>([
  ["session", "session"],
  ["weekly", "weekly"],
  ["monthly", "monthly"],
]);

/** 已知失败码 → 可安全展示的中文短句；其余码原样透传，message 走通用短句。 */
const KNOWN_ERROR_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["NotLogin", "cookie 已过期或无效"],
  ["InvalidCSRFToken", "cookie 不完整"],
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** 构造失败报告：error 只含错误码与人可读短句。 */
function failure(
  accountId: string,
  displayName: string,
  fetchedAt: number,
  code: string,
  message: string,
): AccountReport {
  return {
    accountId,
    displayName,
    sourceId: "ark",
    kind: "windows",
    fetchedAt,
    error: { code, message },
  };
}

/**
 * URL host 白名单校验（SPEC §6）：发送任何凭据**之前**必须先过这一关。
 * URL 不可解析、或 host（含端口）与 `ARK_ALLOWED_HOST` 不完全相等，都返回 false。
 */
export function isArkAllowedUrl(url: string): boolean {
  try {
    return new URL(url).host === ARK_ALLOWED_HOST;
  } catch {
    return false;
  }
}

/**
 * `account.id` → 展示名："ark-a" → "Ark-A"。
 * 契约（TEAM-SYNC §1.2）给的 `ArkAccountConfig` 只有 id/provider/cookie，没有 displayName，
 * 故由 id 派生；若需其他写法，调用方可在展示层覆盖 report.displayName。
 */
function displayNameFor(accountId: string): string {
  const parts = accountId.split(/[-_]+/).filter((part) => part !== "");
  if (parts.length === 0) return accountId;
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("-");
}

/**
 * 纯解析：GetCodingPlanUsage payload → AccountReport。
 *
 * `ResponseMetadata.Error` 存在即失败（HTTP 200 也可能是失败）；`QuotaUsage` 里
 * Level 未知 / Percent 非法 / Level 重复的条目跳过并记 note；`ResetTimestamp` 已是 epoch 秒，直接使用。
 */
export function parseArkUsage(
  payload: unknown,
  fetchedAt: number,
  accountId: string,
  displayName: string,
): AccountReport {
  const fail = (code: string, message: string): AccountReport =>
    failure(accountId, displayName, fetchedAt, code, message);
  const changed = (): AccountReport => fail("unknown-shape", "接口变更");

  const root = asRecord(payload);
  if (root === undefined) return changed();

  const metadata = asRecord(root["ResponseMetadata"]);
  const error = metadata === undefined ? undefined : asRecord(metadata["Error"]);
  if (error !== undefined) {
    const code = error["Code"];
    if (typeof code !== "string" || code === "") return changed();
    const known = KNOWN_ERROR_MESSAGES.get(code);
    if (known !== undefined) return fail(code, known);
    // 未知 code 归入 unknown-shape，而不是把原始 code 塞进 QuotaError.code ——
    // 否则 footer 会展示出 §1.3 码表之外的英文错误码（review P1-1）。
    // 原始 code 经脱敏后记入 notes，保留排查线索。
    const report = fail("unknown-shape", "接口变更");
    return { ...report, notes: [`Ark 返回未知错误码 ${redact(code)}`] };
  }

  const result = asRecord(root["Result"]);
  const rawUsage = result === undefined ? undefined : result["QuotaUsage"];
  if (!Array.isArray(rawUsage)) return changed();

  const windows: QuotaWindow[] = [];
  const notes: string[] = [];

  for (const item of rawUsage) {
    const entry = asRecord(item);
    if (entry === undefined) {
      notes.push("存在结构异常的窗口条目，已跳过");
      continue;
    }
    const rawLevel = entry["Level"];
    const level = typeof rawLevel === "string" ? LEVELS.get(rawLevel) : undefined;
    if (level === undefined) {
      notes.push(`未知窗口 Level "${redact(String(rawLevel))}"，已跳过`);
      continue;
    }
    if (windows.some((existing) => existing.level === level)) {
      notes.push(`窗口 ${level} 重复出现，已跳过`);
      continue;
    }
    const percent = entry["Percent"];
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) {
      notes.push(`窗口 ${level} 的 Percent 不是非负有限数字，已跳过`);
      continue;
    }
    const window: QuotaWindow = { level, percent };
    const resetTimestamp = entry["ResetTimestamp"];
    // epoch 秒，不做毫秒换算
    if (typeof resetTimestamp === "number" && Number.isFinite(resetTimestamp)) {
      window.resetsAt = resetTimestamp;
    }
    windows.push(window);
  }

  if (windows.length === 0) return changed();

  const report: AccountReport = {
    accountId,
    displayName,
    sourceId: "ark",
    kind: "windows",
    windows,
    fetchedAt,
  };
  if (notes.length > 0) report.notes = notes;
  return report;
}

/**
 * 查询某个 Ark 账号的额度。
 * cookie 缺失 / 白名单不通过 / 网络异常 / 超时 / 非 2xx / 响应畸形，一律返回带 error 的报告，不抛异常。
 */
export async function fetchArkUsage(
  account: ArkAccountConfig,
  opts: FetchOptions = {},
): Promise<AccountReport> {
  const fetchedAt = Date.now();
  const displayName = displayNameFor(account.id);
  const fail = (code: string, message: string): AccountReport =>
    failure(account.id, displayName, fetchedAt, code, message);

  if (typeof account.cookie !== "string" || account.cookie.trim() === "") {
    return fail("missing-credential", "未配置 Ark cookie");
  }

  // host 白名单在解析 cookie 与发请求之前：不匹配绝不发送凭据
  if (!isArkAllowedUrl(ARK_USAGE_URL)) {
    return fail("blocked-host", "请求目标不在白名单内，已阻止");
  }

  // x-csrf-token 由 cookie 内联解析得到（SPEC §2.3）：用户只维护一个 cookie 字符串
  const parsed = parseArkCookie(account.cookie);
  if (!parsed.ok) return fail("InvalidCSRFToken", parsed.message);

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const externalSignal = opts.signal;
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    let response: Response;
    try {
      response = await fetchImpl(ARK_USAGE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": parsed.value.csrfToken,
          cookie: account.cookie,
          Accept: "application/json",
        },
        body: "{}",
        redirect: "error", // 拒绝重定向，防止凭据被转发到白名单外的 host（SPEC §6）
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) return fail("timeout", `Ark 接口请求超时（${timeoutMs}ms）`);
      if (isAbortError(err)) return fail("network", "Ark 请求已取消");
      return fail("network", "Ark 网络请求失败");
    }

    if (!response.ok) return fail(`http-${response.status}`, `Ark 接口返回 HTTP ${response.status}`);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // 超时可能落在 body 读取阶段（fetch 已 resolve、body 未读完），
      // 此时应报 timeout，而非误报「接口变更」
      if (timedOut || controller.signal.aborted) {
        return fail("timeout", `Ark 响应读取超时（${timeoutMs}ms）`);
      }
      return fail("unknown-shape", "响应不是合法 JSON");
    }

    return parseArkUsage(payload, fetchedAt, account.id, displayName);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
