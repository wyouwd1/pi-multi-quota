/**
 * 数据源分派层：把「当前模型的 provider + baseUrl」映射到数据源与查询目标。
 *
 * 职责边界：
 * - 只做分派与凭据解析，**不发网络请求**（网络在 sources/*）
 * - 只做组装，**不做缓存**（缓存在 cache.ts，由 index.ts 编排）
 *
 * 为什么按 host 匹配而不是 provider id：本机 provider id 是自定义的
 * （例如 opencode-go-ds），且可能随时改名，而 baseUrl 的 host 是稳定标识。
 */
import type { AccountReport, SourceId } from "./types.js";
import type { ArkAccountConfig, QuotaConfig } from "./config.js";
import { OPENCODE_ACCOUNT_ID, fetchOpenCodeUsage } from "./sources/opencode.js";
import { DEEPSEEK_ACCOUNT_ID, fetchDeepSeekBalance } from "./sources/deepseek.js";
import { fetchArkUsage } from "./sources/ark.js";

/** host → 数据源映射表。改这里之前先读 SPEC §3.1。 */
const HOST_TO_SOURCE: ReadonlyArray<readonly [string, SourceId]> = [
  ["ark.cn-beijing.volces.com", "ark"],
  ["opencode.ai", "opencode"],
  ["api.deepseek.com", "deepseek"],
];

/** 从 baseUrl 判定数据源；无法判定时返回 undefined（调用方据此清空 footer）。 */
export function sourceForBaseUrl(baseUrl: string | undefined): SourceId | undefined {
  if (!baseUrl) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  for (const entry of HOST_TO_SOURCE) {
    if (entry[0] === host) return entry[1];
  }
  return undefined;
}

/**
 * pi 凭据解析器的最小结构契约。
 * 刻意不 import @earendil-works/pi-ai 的 AuthResult —— 该包不在本项目的
 * node_modules 里（由 pi 运行时提供），结构化类型可以避免依赖它的类型路径。
 */
export interface ProviderAuthResolver {
  getProviderAuth(providerId: string): Promise<{ auth?: { apiKey?: string } } | undefined>;
}

/** 一个可执行的查询目标。query() 失败时应返回带 error 的报告，而不是抛异常。 */
export interface QueryTarget {
  accountId: string;
  displayName: string;
  sourceId: SourceId;
  query(): Promise<AccountReport>;
}

export interface ResolveDeps {
  auth: ProviderAuthResolver;
  config: QuotaConfig;
}

/** "ark-a" → "Ark-A"；"ark-b2" → "Ark-B2"。 */
export function arkDisplayName(accountId: string): string {
  const suffix = accountId.replace(/^ark[-_]?/i, "");
  if (suffix.length === 0) return "Ark";
  return `Ark-${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}`;
}

/** 构造「未配置凭据」的报告。用于 config 里存在但 cookie 为空的 Ark 槽位。 */
function missingCredentialReport(
  accountId: string,
  displayName: string,
  sourceId: SourceId,
  kind: AccountReport["kind"],
): AccountReport {
  return {
    accountId,
    displayName,
    sourceId,
    kind,
    fetchedAt: Date.now(),
    error: { code: "missing-credential", message: "未配置" },
  };
}

/**
 * 解析某个数据源下的**全部**查询目标。
 *
 * Ark 会返回配置中的所有账号（这才让「两个账号并排显示」成为可能）；
 * OpenCode 与 DeepSeek 各返回一个目标。
 *
 * 凭据解析刻意延迟到 query() 内部执行：这样一次 `/quota all` 不会因为
 * 某个 provider 没登录而在组装阶段就整体失败。
 */
export function targetsForSource(
  source: SourceId,
  providerId: string,
  deps: ResolveDeps,
): QueryTarget[] {
  if (source === "ark") return arkTargets(deps.config);
  if (source === "opencode") return [openCodeTarget(providerId, deps.auth)];
  if (source === "deepseek") return [deepSeekTarget(providerId, deps.auth)];
  return [];
}

function arkTargets(config: QuotaConfig): QueryTarget[] {
  return config.ark.accounts.map((account: ArkAccountConfig) => {
    const displayName = arkDisplayName(account.id);
    return {
      accountId: account.id,
      displayName,
      sourceId: "ark" as const,
      query: (): Promise<AccountReport> => {
        if (account.cookie.trim().length === 0) {
          return Promise.resolve(
            missingCredentialReport(account.id, displayName, "ark", "windows"),
          );
        }
        return fetchArkUsage(account, { fetchImpl: undefined });
      },
    };
  });
}

function openCodeTarget(providerId: string, auth: ProviderAuthResolver): QueryTarget {
  return {
    accountId: OPENCODE_ACCOUNT_ID,
    displayName: "Zen",
    sourceId: "opencode",
    query: async (): Promise<AccountReport> => {
      const resolved = await auth.getProviderAuth(providerId);
      const apiKey = resolved?.auth?.apiKey;
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        return missingCredentialReport(OPENCODE_ACCOUNT_ID, "Zen", "opencode", "windows");
      }
      return fetchOpenCodeUsage(apiKey);
    },
  };
}

function deepSeekTarget(providerId: string, auth: ProviderAuthResolver): QueryTarget {
  return {
    accountId: DEEPSEEK_ACCOUNT_ID,
    displayName: "DeepSeek",
    sourceId: "deepseek",
    query: async (): Promise<AccountReport> => {
      const resolved = await auth.getProviderAuth(providerId);
      const apiKey = resolved?.auth?.apiKey;
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        return missingCredentialReport(DEEPSEEK_ACCOUNT_ID, "DeepSeek", "deepseek", "balance");
      }
      return fetchDeepSeekBalance(apiKey);
    },
  };
}

/** 数据源的中文展示名（详情视图用）。 */
export function sourceLabel(source: SourceId): string {
  if (source === "ark") return "火山方舟 Ark";
  if (source === "opencode") return "OpenCode Go";
  return "DeepSeek";
}
