/**
 * pi-multi-quota 核心类型定义。
 *
 * 这些类型是跨模块的接口契约（见 tasks/TEAM-SYNC.md §1）。
 * 任何修改必须先更新 TEAM-SYNC.md 的契约表，再改本文件。
 */

/** 额度窗口的粒度。三个数据源统一映射到这三档。 */
export type WindowLevel = "session" | "weekly" | "monthly";

/** 数据源标识。 */
export type SourceId = "ark" | "opencode" | "deepseek";

/** 单个额度窗口。 */
export interface QuotaWindow {
  level: WindowLevel;
  /** 已用百分比，0-100。 */
  percent: number;
  /** 重置时间，epoch 秒。缺失表示该窗口不含重置信息。 */
  resetsAt?: number;
}

/**
 * 余额条目（pay-as-you-go 类数据源）。
 * 金额全程保持字符串，禁止转 float —— 转换会丢精度。
 */
export interface BalanceEntry {
  /** 币种，例如 "CNY" / "USD"。 */
  currency: string;
  /** 总余额，精确保留原始字符串。 */
  total: string;
  /** 赠送余额。 */
  granted?: string;
  /** 充值余额。 */
  toppedUp?: string;
}

/**
 * 归一化错误。message 必须是可安全展示的文本：
 * 只允许包含错误码，严禁包含 cookie、API key 或原始响应体。
 */
export interface QuotaError {
  code: string;
  message: string;
}

/** 单个账号的一次查询结果。 */
export interface AccountReport {
  /** 账号唯一标识，例如 "ark-a" / "ark-b" / "opencode" / "deepseek"。 */
  accountId: string;
  /** 展示名，例如 "Ark-A"。 */
  displayName: string;
  sourceId: SourceId;
  kind: "windows" | "balance";
  windows?: QuotaWindow[];
  balances?: BalanceEntry[];
  /** 抓到数据的时刻，epoch 毫秒。 */
  fetchedAt: number;
  error?: QuotaError;
  /** true 表示展示的是上次成功的数据（本次查询失败）。 */
  stale?: boolean;
  /** 非致命提示，例如某个窗口 status 未知。 */
  notes?: string[];
}
