/**
 * Ark 控制台 cookie 解析。
 *
 * 依据 SPEC §2.3 的实测结论：
 * - 请求头 `x-csrf-token` 的值与 cookie 中 `csrfToken=` 完全相同
 *   ⇒ 用户只需维护一个 cookie 字符串，程序自行取 csrf。
 * - `digest` 是 SSO access token（JWT），其 `exp` 约 24 小时后到期，只能人工更新。
 *   ⇒ 只做 base64url 解码 payload，**不验签**（无密钥、也无需信任校验）。
 *
 * 本模块是纯函数：不发网络请求、不读配置、不写日志。
 * 错误一律走 result 返回，绝不抛异常；message 只含错误码语义的中文短句，
 * 严禁回显 cookie 原文。
 */

export interface ParsedArkCookie {
  csrfToken: string;
  /** cookie 中 AccountID 的值；缺失时 undefined。用于账号防呆比对。 */
  accountId?: string;
  /** digest 的 exp，epoch 毫秒；缺失或不可解析时 undefined。 */
  digestExpMs?: number;
  /** 相对 now 的剩余毫秒；digestExpMs 缺失时 undefined。可为负（已过期）。 */
  expiresInMs?: number;
}

export type CookieParseResult =
  | { ok: true; value: ParsedArkCookie }
  | { ok: false; code: "missing-csrf" | "missing-digest" | "malformed-digest"; message: string };

const CSRF_KEY = "csrfToken";
const ACCOUNT_ID_KEY = "AccountID";
const DIGEST_KEY = "digest";

/** base64url 段的合法字符集；用它先挡掉明显非法的 payload，避免 Buffer 静默丢弃字符。 */
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** cookie 值两端可能被双引号包裹（RFC 6265 允许），解析时剥掉。 */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/** 拆 cookie 串为键值表；同名键后者覆盖前者（取最后一个）。 */
function collectPairs(raw: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    // 没有键名或没有 "=" 的碎片直接忽略，不能当成有效键值对
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = unquote(trimmed.slice(eq + 1).trim());
    pairs.set(name, value);
  }
  return pairs;
}

/** 把 JWT payload 段解成 exp（epoch 秒）；任何畸形返回 undefined。 */
function decodeJwtExpSeconds(payloadSegment: string | undefined): number | undefined {
  if (payloadSegment === undefined || payloadSegment === "" || !BASE64URL_SEGMENT.test(payloadSegment)) {
    return undefined;
  }
  const padded = payloadSegment.padEnd(Math.ceil(payloadSegment.length / 4) * 4, "=");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const exp = (payload as Record<string, unknown>)["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  return exp;
}

/**
 * 解析 Ark 控制台 cookie。
 *
 * @param raw cookie 原文（浏览器复制出来的整串）
 * @param now 当前时刻，epoch 毫秒；可注入以便测试，默认 `Date.now()`
 */
export function parseArkCookie(raw: string, now: number = Date.now()): CookieParseResult {
  const pairs = collectPairs(raw);

  const csrfToken = pairs.get(CSRF_KEY);
  if (csrfToken === undefined || csrfToken === "") {
    return {
      ok: false,
      code: "missing-csrf",
      message: "cookie 中缺少 csrfToken，请复制完整的 cookie",
    };
  }

  const digest = pairs.get(DIGEST_KEY);
  if (digest === undefined || digest === "") {
    return {
      ok: false,
      code: "missing-digest",
      message: "cookie 中缺少 digest，请重新登录后复制完整的 cookie",
    };
  }

  const segments = digest.split(".");
  const expSeconds = segments.length === 3 ? decodeJwtExpSeconds(segments[1]) : undefined;
  if (expSeconds === undefined) {
    return {
      ok: false,
      code: "malformed-digest",
      message: "cookie 的 digest 无法解析出有效期，请重新登录后复制完整的 cookie",
    };
  }

  const digestExpMs = expSeconds * 1000;
  const value: ParsedArkCookie = {
    csrfToken,
    digestExpMs,
    expiresInMs: digestExpMs - now,
  };

  const accountId = pairs.get(ACCOUNT_ID_KEY);
  if (accountId !== undefined && accountId !== "") {
    value.accountId = accountId;
  }

  return { ok: true, value };
}

/** 把一段正向时长格式化为「X 天 Y 小时」/「X 小时 Y 分」/「X 分钟」/「<1 分钟」。 */
function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1 分钟";

  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  return `${minutes} 分钟`;
}

/** 人可读剩余时间，例如 "3 小时 12 分" / "已过期 20 分钟" / "<1 分钟"。 */
export function describeExpiry(ms: number): string {
  const text = formatDuration(Math.abs(ms));
  return ms < 0 ? `已过期 ${text}` : text;
}
