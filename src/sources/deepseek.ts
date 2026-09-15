/**
 * DeepSeek 余额适配器。
 *
 * 契约见 tasks/TEAM-SYNC.md §1.2，实测响应样例见 SPEC.md §2.2。
 * 硬约束：金额（total / granted / toppedUp）全程保持接口返回的**字符串**，
 * 不得转 Number —— 转 float 会丢精度（SPEC §2.2 / TEAM-SYNC §4.7）。
 */

import type { FetchOptions } from "./opencode.js";
import type { AccountReport, BalanceEntry } from "../types.js";

/** DeepSeek 余额查询端点。 */
export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

/** DeepSeek 在 AccountReport 中的账号 id。 */
export const DEEPSEEK_ACCOUNT_ID = "deepseek";

const DISPLAY_NAME = "DeepSeek";

/** 默认超时，与 src/sources/opencode.ts 保持一致。 */
const DEFAULT_TIMEOUT_MS = 20000;

/** 构造失败报告：error 只含错误码与人可读短句，不含凭据与响应体。 */
function failure(fetchedAt: number, code: string, message: string): AccountReport {
  return {
    accountId: DEEPSEEK_ACCOUNT_ID,
    displayName: DISPLAY_NAME,
    sourceId: "deepseek",
    kind: "balance",
    fetchedAt,
    error: { code, message },
  };
}

/** 类型守卫：非对象（含 null 与数组）返回 undefined。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 字段守卫：只接受非空字符串，数字形态一律不认（避免隐式精度损失）。 */
function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * 纯解析：DeepSeek `/user/balance` payload → AccountReport。
 *
 * - `is_available === false`：账户不可用，返回带 error 且**不带 balances** 的报告。
 * - `balance_infos` 为空或全部结构异常：返回 error（绝不显示 ¥0.00）。
 * - 多币种各自一条 BalanceEntry，不相加、不换算。
 *
 * 畸形 payload 不抛异常，统一走 error 报告，便于 registry 直接展示。
 */
export function parseDeepSeekBalance(payload: unknown, fetchedAt: number): AccountReport {
  const root = asRecord(payload);
  if (root === undefined) {
    return failure(fetchedAt, "unknown-shape", "DeepSeek 余额响应不是对象");
  }

  if (root["is_available"] === false) {
    return failure(fetchedAt, "http-402", "DeepSeek 账户当前不可用（余额不足或账户已停用）");
  }

  const rawInfos = root["balance_infos"];
  if (!Array.isArray(rawInfos)) {
    return failure(fetchedAt, "unknown-shape", "DeepSeek 余额响应缺少 balance_infos 数组");
  }

  const balances: BalanceEntry[] = [];
  let skipped = 0;

  for (const rawInfo of rawInfos) {
    const info = asRecord(rawInfo);
    if (info === undefined) {
      skipped += 1;
      continue;
    }
    const currency = asNonEmptyString(info["currency"]);
    const total = asNonEmptyString(info["total_balance"]);
    if (currency === undefined || total === undefined) {
      skipped += 1;
      continue;
    }

    const entry: BalanceEntry = { currency, total };
    const granted = asNonEmptyString(info["granted_balance"]);
    if (granted !== undefined) entry.granted = granted;
    const toppedUp = asNonEmptyString(info["topped_up_balance"]);
    if (toppedUp !== undefined) entry.toppedUp = toppedUp;
    balances.push(entry);
  }

  if (balances.length === 0) {
    return failure(fetchedAt, "unknown-shape", "DeepSeek 余额响应没有可用的余额记录");
  }

  const report: AccountReport = {
    accountId: DEEPSEEK_ACCOUNT_ID,
    displayName: DISPLAY_NAME,
    sourceId: "deepseek",
    kind: "balance",
    fetchedAt,
    balances,
  };
  if (skipped > 0) {
    report.notes = [`${skipped} 条余额记录结构异常，已跳过`];
  }
  return report;
}

/**
 * 拉取 DeepSeek 余额。
 * 网络异常 / 超时 / 非 2xx / 响应畸形一律返回带 error 的 AccountReport，不抛异常。
 */
export async function fetchDeepSeekBalance(
  apiKey: string,
  opts: FetchOptions = {},
): Promise<AccountReport> {
  const fetchedAt = Date.now();

  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    return failure(fetchedAt, "missing-credential", "未配置 DeepSeek API key");
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const externalSignal = opts.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    let response: Response;
    try {
      response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) {
        return failure(fetchedAt, "timeout", `DeepSeek 接口请求超时（${timeoutMs}ms）`);
      }
      if (isAbortError(err)) {
        return failure(fetchedAt, "network", "DeepSeek 请求已取消");
      }
      return failure(fetchedAt, "network", "DeepSeek 网络请求失败");
    }

    if (!response.ok) {
      return failure(fetchedAt, `http-${response.status}`, `DeepSeek 接口返回 HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (timedOut || controller.signal.aborted) {
        return failure(fetchedAt, "timeout", `DeepSeek 响应读取超时（${timeoutMs}ms）`);
      }
      return failure(fetchedAt, "unknown-shape", "DeepSeek 响应不是合法 JSON");
    }

    return parseDeepSeekBalance(payload, fetchedAt);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
