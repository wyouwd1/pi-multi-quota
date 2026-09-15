/**
 * OpenCode Go（Zen）额度适配器。
 *
 * 端点与响应结构见 SPEC §2.1，错误码取值见 tasks/TEAM-SYNC.md §1.3。
 * 零运行时依赖；网络调用通过 `fetchImpl` 注入，测试不触网。
 */
import type { AccountReport, QuotaWindow, WindowLevel } from "../types.js";

export const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const OPENCODE_ACCOUNT_ID = "opencode";

/** fetch 未传 timeoutMs 时的默认超时。 */
const DEFAULT_TIMEOUT_MS = 20000;

/** 响应中的窗口字段 → 内部窗口粒度。顺序即 windows 数组的输出顺序。 */
const WINDOW_FIELDS: ReadonlyArray<readonly [string, WindowLevel]> = [
  ["rolling", "session"],
  ["weekly", "weekly"],
  ["monthly", "monthly"],
];

/** 视为可用的窗口状态，其余状态一律降级为 note。 */
const USABLE_STATUSES: ReadonlySet<string> = new Set(["ok", "rate-limited"]);

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ISO 时间字符串 → epoch 秒；不可解析时返回 undefined（该窗口不带重置时间）。 */
function toEpochSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000);
}

/** 从错误对象取可安全展示的短句；绝不回显原始响应体。 */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message !== "" ? err.message : "用量数据结构无法识别";
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** 构造失败报告（不含凭据、不含响应体）。 */
function errorReport(code: string, message: string, fetchedAt: number): AccountReport {
  return {
    accountId: OPENCODE_ACCOUNT_ID,
    displayName: "Zen",
    sourceId: "opencode",
    kind: "windows",
    fetchedAt,
    error: { code, message },
  };
}

/**
 * 纯解析：OpenCode `/v1/usage` 响应 → AccountReport。
 *
 * 窗口映射：rolling → session，weekly → weekly，monthly → monthly。
 * 状态非 ok / rate-limited 的窗口跳过并记入 notes；percent 非非负有限数字的窗口同样跳过。
 * 响应结构不可识别或三个窗口全部不可用时抛 Error（message 不含凭据）。
 */
export function parseOpenCodeUsage(payload: unknown, fetchedAt: number): AccountReport {
  const usage = isRecord(payload) ? payload.usage : undefined;
  if (!isRecord(usage)) {
    throw new Error("响应缺少 usage 对象");
  }

  const windows: QuotaWindow[] = [];
  const notes: string[] = [];

  for (const [field, level] of WINDOW_FIELDS) {
    const raw = usage[field];
    if (!isRecord(raw)) {
      notes.push(`窗口 ${field} 缺失或结构异常，已跳过`);
      continue;
    }
    const status = raw.status;
    if (typeof status !== "string" || !USABLE_STATUSES.has(status)) {
      notes.push(`窗口 ${field} 状态为 ${typeof status === "string" ? status : "缺失"}，已跳过`);
      continue;
    }
    const percent = raw.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) {
      notes.push(`窗口 ${field} 的 percent 不是非负有限数字，已跳过`);
      continue;
    }
    const window: QuotaWindow = { level, percent };
    const resetsAt = toEpochSeconds(raw.resetsAt);
    if (resetsAt !== undefined) window.resetsAt = resetsAt;
    windows.push(window);
  }

  if (windows.length === 0) {
    throw new Error("响应中没有任何可用窗口");
  }

  const report: AccountReport = {
    accountId: OPENCODE_ACCOUNT_ID,
    displayName: "Zen",
    sourceId: "opencode",
    kind: "windows",
    windows,
    fetchedAt,
  };
  if (notes.length > 0) report.notes = notes;
  return report;
}

/**
 * 查询 OpenCode Go 额度。
 *
 * 网络异常 / 超时 / 非 2xx / 响应结构不可识别一律返回带 error 的 AccountReport，不抛异常。
 */
export async function fetchOpenCodeUsage(apiKey: string, opts: FetchOptions = {}): Promise<AccountReport> {
  const fetchedAt = Date.now();
  if (typeof apiKey !== "string" || apiKey === "") {
    return errorReport("missing-credential", "未配置 OpenCode API key", fetchedAt);
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  // 外部 signal 与超时合并到同一个 AbortController：任一触发都中止请求。
  const controller = new AbortController();
  const external = opts.signal;
  const onExternalAbort = (): void => controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (external !== undefined) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  const cleanup = (): void => {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  };

  try {
    const response = await fetchImpl(OPENCODE_USAGE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      // 拒绝跟随重定向，防止凭据被转发到白名单外的 host（SPEC §6）。
      redirect: "error",
      signal: controller.signal,
    });

    if (controller.signal.aborted) {
      return errorReport("timeout", "请求超时", fetchedAt);
    }
    if (!response.ok) {
      return errorReport(`http-${response.status}`, `HTTP ${response.status}`, fetchedAt);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return errorReport("unknown-shape", "响应不是合法 JSON", fetchedAt);
    }

    try {
      return parseOpenCodeUsage(payload, fetchedAt);
    } catch (err) {
      return errorReport("unknown-shape", messageOf(err), fetchedAt);
    }
  } catch (err) {
    if (controller.signal.aborted || isAbortError(err)) {
      return errorReport("timeout", "请求超时", fetchedAt);
    }
    return errorReport("network", "网络请求失败", fetchedAt);
  } finally {
    cleanup();
  }
}
