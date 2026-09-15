/**
 * 配置存储：读写 ~/.pi/agent/multi-quota.json，含权限加固、损坏保护与脱敏工具。
 *
 * 约束（SPEC.md §6 安全边界 · §12 Boundaries）：
 * - 文件损坏时只报错，**绝不覆盖**用户文件；
 * - 写入走「临时文件 + rename」原子替换，权限固定 600；
 * - redact() 供一切日志/错误信息使用，禁止 cookie / key 原文外泄。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 单个 Ark 账号的配置。 */
export interface ArkAccountConfig {
  /** 账号 id，例如 "ark-a"。 */
  id: string;
  /** 绑定的 pi provider id，例如 "volcengine"。 */
  provider: string;
  /** 控制台 cookie 原文。 */
  cookie: string;
}

/** 持久化配置结构。 */
export interface QuotaConfig {
  ark: { accounts: ArkAccountConfig[] };
}

/** 测试用覆盖变量：指向隔离的配置文件，避免测试污染真实 ~/.pi/agent/。 */
const CONFIG_PATH_ENV = "PI_MULTI_QUOTA_CONFIG";

/** 配置文件绝对路径：~/.pi/agent/multi-quota.json。 */
export function configPath(): string {
  const override = process.env[CONFIG_PATH_ENV];
  if (override !== undefined && override.trim() !== "") return path.resolve(override);
  return path.join(os.homedir(), ".pi", "agent", "multi-quota.json");
}

/** 默认空结构。每次返回新对象，避免调用方改到共享引用。 */
function defaultConfig(): QuotaConfig {
  return { ark: { accounts: [] } };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 错误码，用于拼接不含敏感内容的错误信息。 */
function errorCode(err: unknown): string {
  const code = asObject(err)?.["code"];
  return typeof code === "string" ? code : "unknown";
}

/** 把磁盘上的任意 JSON 规范化成合法 QuotaConfig：缺字段补默认值，非法账号条目丢弃。 */
function normalizeConfig(raw: unknown): QuotaConfig {
  const root = asObject(raw);
  const ark = root === undefined ? undefined : asObject(root["ark"]);
  const rawAccounts = ark === undefined || !Array.isArray(ark["accounts"]) ? [] : ark["accounts"];
  const accounts: ArkAccountConfig[] = [];
  for (const item of rawAccounts) {
    const entry = asObject(item);
    if (entry === undefined) continue;
    const { id, provider, cookie } = entry;
    if (typeof id !== "string" || typeof provider !== "string" || typeof cookie !== "string") continue;
    accounts.push({ id, provider, cookie });
  }
  return { ark: { accounts } };
}

/** 文件不存在 → 返回默认空结构；JSON 损坏 → 抛错，绝不覆盖用户文件。 */
export function loadConfig(): QuotaConfig {
  const file = configPath();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return defaultConfig();
    throw new Error(`读取配置失败：${file}（${errorCode(err)}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 不覆盖用户文件：损坏时只报错，把修复权交回用户。
    throw new Error(`配置文件不是合法 JSON，已保留原文件未做修改：${file}`);
  }
  return normalizeConfig(parsed);
}

/** 同进程内的临时文件序号，保证同毫秒多次写入不撞名。 */
let tmpCounter = 0;

/** 写入并将权限设为 600。先写临时文件再 rename，避免中断留下半截配置。 */
export function saveConfig(cfg: QuotaConfig): void {
  const file = configPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  tmpCounter += 1;
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}-${tmpCounter}.tmp`);
  const data = `${JSON.stringify(cfg, null, 2)}\n`;
  try {
    // flag "wx"：同名临时文件已存在时直接失败，避免跟随符号链接写入他人文件
    fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600); // umask 可能放宽 mode，显式收紧
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败不掩盖原始写入错误
    }
    throw err;
  }
}

const REDACTED = "<redacted>";

/**
 * 敏感键值对：`digest=…` / `"csrfToken": "…"` / `CSRF-Token: …` 等形态，值一律替换。
 * 键名列表是脱敏的唯一来源，新增键名只需改这里。
 */
const KEY_VALUE_PATTERN =
  /(["']?)(digest|csrf_?token|csrf-token|x-csrf-token|cookie|set-cookie|token|access_?token|refresh_?token|sessionid|session_id|jsessionid|session|sso_?token|passport|passwd|password|secret|api[_-]?key)(["']?\s*[=:]\s*)(["']?)([^\s"',;]+)/gi;

/** 形如 `k=v; k=v; ...` 的 cookie 串（≥2 对键值）。 */
const COOKIE_SHAPE_PATTERN = /[A-Za-z0-9_%.-]+=[^;\s"']*(?:\s*;\s*[A-Za-z0-9_%.-]+=[^;\s"']*)+/g;

/** `authorization` 行通常整段都是凭据，值一律抹掉。 */
const AUTHORIZATION_PATTERN = /(\bauthorization\b["']?\s*[=:]\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\r\n]+)/gi;

const BEARER_PATTERN = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** `sk-` / `ark-` 前缀的 API key。 */
const API_KEY_PATTERN = /\b(?:sk|ark)-[A-Za-z0-9_-]{6,}/g;

/** 只有含敏感键名的 cookie 串才整段替换，普通 `a=1; b=2` 文本保持原样。 */
function containsSensitiveKey(cookieText: string): boolean {
  KEY_VALUE_PATTERN.lastIndex = 0; // 全局正则带状态，进出都复位
  const found = KEY_VALUE_PATTERN.test(cookieText);
  KEY_VALUE_PATTERN.lastIndex = 0;
  return found;
}

/** 把文本中的 cookie/key 值替换为 <redacted>，供任何日志/错误信息使用。 */
export function redact(text: string): string {
  return text
    .replace(COOKIE_SHAPE_PATTERN, (match) => (containsSensitiveKey(match) ? REDACTED : match))
    .replace(AUTHORIZATION_PATTERN, `$1${REDACTED}`)
    .replace(KEY_VALUE_PATTERN, (_match, q1: string, key: string, sep: string, q2: string) => `${q1}${key}${sep}${q2}${REDACTED}`)
    .replace(BEARER_PATTERN, `$1${REDACTED}`)
    .replace(API_KEY_PATTERN, REDACTED);
}

export function findArkAccountByProvider(cfg: QuotaConfig, providerId: string): ArkAccountConfig | undefined {
  return cfg.ark.accounts.find((account) => account.provider === providerId);
}

export function findArkAccountById(cfg: QuotaConfig, id: string): ArkAccountConfig | undefined {
  return cfg.ark.accounts.find((account) => account.id === id);
}

/** 按 id upsert；若同 id 已存在则替换其 provider/cookie。入参与其中的账号对象都不被修改。 */
export function upsertArkAccount(cfg: QuotaConfig, account: ArkAccountConfig): QuotaConfig {
  const next: ArkAccountConfig = { id: account.id, provider: account.provider, cookie: account.cookie };
  const index = cfg.ark.accounts.findIndex((existing) => existing.id === account.id);
  if (index === -1) return { ark: { accounts: [...cfg.ark.accounts, next] } };
  return { ark: { accounts: cfg.ark.accounts.map((existing, i) => (i === index ? next : existing)) } };
}
