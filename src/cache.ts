/**
 * 额度缓存层：TTL、stale 标记、失败退避与并发去重。
 *
 * 设计要点：
 * - 所有时间点通过 `now` 参数注入，测试不依赖真实计时器。
 * - 缓存内部持有一份浅拷贝，`noteFailure` 不去修改调用方传入的对象。
 * - 库文件静默，不打印任何日志；错误信息不落缓存（由调用方负责脱敏）。
 */
import type { AccountReport } from "./types.js";

export interface QuotaCacheOptions {
  /** 数据新鲜期，默认 5 分钟。 */
  ttlMs?: number;
  /** 退避初值，默认 5 分钟。 */
  backoffBaseMs?: number;
  /** 退避上限，默认 30 分钟。 */
  backoffMaxMs?: number;
}

/**
 * 缓存句柄。仅作为不透明标记类型对外暴露，
 * 内部状态通过 CacheState 在模块内访问。
 */
export interface QuotaCache {
  readonly __brand: "QuotaCache";
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_BACKOFF_BASE_MS = 5 * 60 * 1000;
const DEFAULT_BACKOFF_MAX_MS = 30 * 60 * 1000;

/** 连续失败计数与下次允许查询的时刻。 */
interface FailureState {
  count: number;
  nextAllowedAt: number;
}

interface CacheState {
  readonly __brand: "QuotaCache";
  readonly ttlMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** 最近一次数据（可能已过期、可能已标 stale）。 */
  readonly reports: Map<string, AccountReport>;
  readonly failures: Map<string, FailureState>;
  /** 在途 Promise，key 由 dedupe 调用方决定。 */
  readonly inflight: Map<string, Promise<unknown>>;
}

export function createCache(opts: QuotaCacheOptions = {}): QuotaCache {
  const cache: CacheState = {
    __brand: "QuotaCache",
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
    backoffBaseMs: opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
    backoffMaxMs: opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
    reports: new Map(),
    failures: new Map(),
    inflight: new Map(),
  };
  return cache;
}

/** 把不透明句柄还原为内部状态。 */
function stateOf(cache: QuotaCache): CacheState {
  return cache as CacheState;
}

/** 第 n 次连续失败（n ≥ 1）的退避时长，以 backoffMaxMs 封顶。 */
function backoffDelayMs(state: CacheState, failureCount: number): number {
  const exponent = failureCount > 1 ? failureCount - 1 : 0;
  const delay = state.backoffBaseMs * 2 ** exponent;
  return Math.min(delay, state.backoffMaxMs);
}

/** 未过期（now - fetchedAt < ttlMs）才返回。 */
export function getFresh(cache: QuotaCache, accountId: string, now?: number): AccountReport | undefined {
  const state = stateOf(cache);
  const report = state.reports.get(accountId);
  if (!report) return undefined;
  const at = now ?? Date.now();
  return at - report.fetchedAt < state.ttlMs ? report : undefined;
}

/** 即使已过期也返回，调用方据 `stale` / `fetchedAt` 判断展示方式。 */
export function getLastKnown(cache: QuotaCache, accountId: string): AccountReport | undefined {
  return stateOf(cache).reports.get(accountId);
}

/** 记录一次成功数据；report.fetchedAt 有效时以它为准，否则用 now。 */
export function put(cache: QuotaCache, report: AccountReport, now?: number): void {
  const state = stateOf(cache);
  const fetchedAt = Number.isFinite(report.fetchedAt) ? report.fetchedAt : (now ?? Date.now());
  state.reports.set(report.accountId, { ...report, fetchedAt });
}

/** 查询失败：已有数据标记为 stale，并累计失败计数用于退避。 */
export function noteFailure(cache: QuotaCache, accountId: string, now?: number): void {
  const state = stateOf(cache);
  const at = now ?? Date.now();

  const existing = state.reports.get(accountId);
  if (existing && existing.stale !== true) {
    state.reports.set(accountId, { ...existing, stale: true });
  }

  const count = (state.failures.get(accountId)?.count ?? 0) + 1;
  state.failures.set(accountId, { count, nextAllowedAt: at + backoffDelayMs(state, count) });
}

/** 查询成功：清空失败计数与退避窗口。 */
export function noteSuccess(cache: QuotaCache, accountId: string): void {
  stateOf(cache).failures.delete(accountId);
}

/**
 * 是否应当发起网络查询：
 * 成功数据仍新鲜 → false；失败后尚在退避窗口内 → false；其余 → true。
 */
export function shouldQuery(cache: QuotaCache, accountId: string, now?: number): boolean {
  const state = stateOf(cache);
  const at = now ?? Date.now();
  if (getFresh(cache, accountId, at)) return false;

  const failure = state.failures.get(accountId);
  if (failure && at < failure.nextAllowedAt) return false;

  return true;
}

/**
 * 并发去重：同一 key 的在途 Promise 直接复用。
 * 无论成功或失败都在 settle 后清除，避免永久缓存 rejected promise；
 * fn 同步抛错时不入表（否则会留下永不 settle 的条目）。
 */
export function dedupe<T>(cache: QuotaCache, key: string, fn: () => Promise<T>): Promise<T> {
  const state = stateOf(cache);
  const existing = state.inflight.get(key);
  if (existing) return existing as Promise<T>;

  let inner: Promise<T>;
  try {
    inner = fn();
  } catch (err) {
    return Promise.reject(err);
  }

  const tracked = inner.finally(() => {
    if (state.inflight.get(key) === tracked) state.inflight.delete(key);
  });
  state.inflight.set(key, tracked);
  return tracked;
}
