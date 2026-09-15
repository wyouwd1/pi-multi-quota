/**
 * src/cache.ts 单元测试。
 *
 * 时间全部通过 now 参数注入，不使用真实计时器；
 * dedupe 用显式 Promise 闸门控制 settle 时机。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createCache,
  dedupe,
  getFresh,
  getLastKnown,
  noteFailure,
  noteSuccess,
  put,
  shouldQuery,
} from "../src/cache.js";
import type { AccountReport } from "../src/types.js";

const MINUTE = 60 * 1000;
const T0 = 1_700_000_000_000;

function makeReport(accountId: string, fetchedAt: number): AccountReport {
  return {
    accountId,
    displayName: accountId.toUpperCase(),
    sourceId: "opencode",
    kind: "windows",
    windows: [{ level: "session", percent: 12, resetsAt: 1_700_001_000 }],
    fetchedAt,
  };
}

test("TTL 内 getFresh 命中，超期后只有 getLastKnown 返回", () => {
  const cache = createCache();
  put(cache, makeReport("opencode", T0), T0);

  assert.equal(getFresh(cache, "opencode", T0)?.accountId, "opencode");
  assert.equal(getFresh(cache, "opencode", T0 + 5 * MINUTE - 1)?.accountId, "opencode");
  // 恰好等于 ttl 即视为过期
  assert.equal(getFresh(cache, "opencode", T0 + 5 * MINUTE), undefined);
  assert.equal(getFresh(cache, "opencode", T0 + 60 * MINUTE), undefined);

  assert.equal(getLastKnown(cache, "opencode")?.fetchedAt, T0);
  assert.equal(getLastKnown(cache, "unknown-account"), undefined);
});

test("put 优先使用 report.fetchedAt，缺失时回落到 now", () => {
  const cache = createCache();
  const staged = { ...makeReport("opencode", T0) };
  // 模拟运行时缺失 fetchedAt 的畸形输入
  (staged as { fetchedAt?: number }).fetchedAt = undefined;

  put(cache, staged, T0 + 3 * MINUTE);

  assert.equal(getLastKnown(cache, "opencode")?.fetchedAt, T0 + 3 * MINUTE);
  assert.equal(getFresh(cache, "opencode", T0 + 3 * MINUTE + MINUTE)?.fetchedAt, T0 + 3 * MINUTE);
});

test("自定义 ttlMs 生效", () => {
  const cache = createCache({ ttlMs: 1000 });
  put(cache, makeReport("deepseek", T0), T0);

  assert.ok(getFresh(cache, "deepseek", T0 + 999));
  assert.equal(getFresh(cache, "deepseek", T0 + 1000), undefined);
});

test("noteFailure 把已有数据标记为 stale 且不改动调用方对象", () => {
  const cache = createCache();
  const original = makeReport("ark-a", T0);
  put(cache, original, T0);

  noteFailure(cache, "ark-a", T0 + 1000);

  assert.equal(getLastKnown(cache, "ark-a")?.stale, true);
  assert.equal(original.stale, undefined, "失败不应回写调用方持有的对象");
  // 其他账号不受影响
  put(cache, makeReport("ark-b", T0), T0);
  assert.equal(getLastKnown(cache, "ark-b")?.stale, undefined);
});

test("noteFailure 在没有历史数据时只记录退避", () => {
  const cache = createCache();
  noteFailure(cache, "ark-b", T0);

  assert.equal(getLastKnown(cache, "ark-b"), undefined);
  assert.equal(shouldQuery(cache, "ark-b", T0), false);
});

test("shouldQuery：无数据无失败为 true，fresh 数据为 false", () => {
  const cache = createCache();
  assert.equal(shouldQuery(cache, "opencode", T0), true);

  put(cache, makeReport("opencode", T0), T0);
  assert.equal(shouldQuery(cache, "opencode", T0), false);
  assert.equal(shouldQuery(cache, "opencode", T0 + 5 * MINUTE - 1), false);
  // 数据过期后重新可查
  assert.equal(shouldQuery(cache, "opencode", T0 + 5 * MINUTE), true);
});

test("shouldQuery 在退避窗口内为 false，窗口结束即刻为 true", () => {
  const cache = createCache();
  noteFailure(cache, "ark-a", T0);

  assert.equal(shouldQuery(cache, "ark-a", T0), false);
  assert.equal(shouldQuery(cache, "ark-a", T0 + 5 * MINUTE - 1), false);
  assert.equal(shouldQuery(cache, "ark-a", T0 + 5 * MINUTE), true);
});

test("连续失败退避递增并被 backoffMaxMs 封顶", () => {
  const cache = createCache({ backoffBaseMs: 1000, backoffMaxMs: 4000 });

  // 第 1 次：1000ms
  noteFailure(cache, "ark-b", T0);
  assert.equal(shouldQuery(cache, "ark-b", T0 + 999), false);
  assert.equal(shouldQuery(cache, "ark-b", T0 + 1000), true);

  // 第 2 次：2000ms
  noteFailure(cache, "ark-b", T0);
  assert.equal(shouldQuery(cache, "ark-b", T0 + 1999), false);
  assert.equal(shouldQuery(cache, "ark-b", T0 + 2000), true);

  // 第 3 次：4000ms
  noteFailure(cache, "ark-b", T0);
  assert.equal(shouldQuery(cache, "ark-b", T0 + 3999), false);
  assert.equal(shouldQuery(cache, "ark-b", T0 + 4000), true);

  // 第 4/5 次：8000 / 16000 均被 4000ms 封顶
  noteFailure(cache, "ark-b", T0);
  assert.equal(shouldQuery(cache, "ark-b", T0 + 3999), false);
  noteFailure(cache, "ark-b", T0);
  assert.equal(shouldQuery(cache, "ark-b", T0 + 3999), false);
  assert.equal(shouldQuery(cache, "ark-b", T0 + 4000), true);
});

test("noteSuccess 重置退避，下一次失败从初值重新计数", () => {
  const cache = createCache({ backoffBaseMs: 1000, backoffMaxMs: 60_000 });

  noteFailure(cache, "opencode", T0);
  noteFailure(cache, "opencode", T0);
  assert.equal(shouldQuery(cache, "opencode", T0 + 1999), false);

  noteSuccess(cache, "opencode");
  assert.equal(shouldQuery(cache, "opencode", T0 + 1), true);

  noteFailure(cache, "opencode", T0 + 1000);
  assert.equal(shouldQuery(cache, "opencode", T0 + 1000 + 999), false);
  assert.equal(shouldQuery(cache, "opencode", T0 + 1000 + 1000), true);
});

test("dedupe：同 key 并发调用只执行一次 fn", async () => {
  const cache = createCache();
  let calls = 0;
  let release!: (value: string) => void;
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });

  const fn = (): Promise<string> => {
    calls += 1;
    return gate;
  };

  const first = dedupe(cache, "opencode", fn);
  const second = dedupe(cache, "opencode", fn);
  assert.equal(calls, 1);

  release("done");
  assert.deepEqual(await Promise.all([first, second]), ["done", "done"]);
  assert.equal(calls, 1);

  // settle 后条目清除，后续调用重新执行
  assert.equal(await dedupe(cache, "opencode", async () => "again"), "again");
});

test("dedupe：不同 key 互不干扰", async () => {
  const cache = createCache();
  let calls = 0;
  const fn = async (): Promise<number> => {
    calls += 1;
    return calls;
  };

  const [a, b] = await Promise.all([dedupe(cache, "ark-a", fn), dedupe(cache, "ark-b", fn)]);
  assert.equal(calls, 2);
  assert.deepEqual([a, b].sort(), [1, 2]);
});

test("dedupe：并发共享失败后不缓存 rejected promise", async () => {
  const cache = createCache();
  let calls = 0;
  const failing = (): Promise<never> => {
    calls += 1;
    return Promise.reject(new Error("boom"));
  };

  const first = dedupe(cache, "deepseek", failing);
  const second = dedupe(cache, "deepseek", failing);
  assert.equal(calls, 1);
  await assert.rejects(first, /boom/);
  await assert.rejects(second, /boom/);

  // 失败已清除，下一次调用重新执行
  await assert.rejects(dedupe(cache, "deepseek", failing), /boom/);
  assert.equal(calls, 2);

  // 失败之后再成功也能拿到结果
  assert.equal(await dedupe(cache, "deepseek", async () => "ok"), "ok");
});

test("dedupe：fn 同步抛错时不污染在途表", async () => {
  const cache = createCache();
  let calls = 0;
  const throwing = (): Promise<never> => {
    calls += 1;
    throw new Error("sync-fail");
  };

  await assert.rejects(dedupe(cache, "ark-a", throwing), /sync-fail/);
  await assert.rejects(dedupe(cache, "ark-a", throwing), /sync-fail/);
  assert.equal(calls, 2);
});
