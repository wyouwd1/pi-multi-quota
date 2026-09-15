/**
 * registry 层测试。
 *
 * 背景（review-security P2-5）：`registry.ts` 是唯一把配置里的 Ark cookie
 * 与 pi auth 解析出的 apiKey 送到 fetch 的路径，此前完全没有测试覆盖。
 * 这里锁定两条安全属性：
 *   1. 凭据为空时**不发起任何网络请求**（而不是发出一个必然失败的请求）
 *   2. host 判定必须精确，子域名/相似域名不得误命中
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { QuotaConfig } from "../src/config.js";
import {
  arkDisplayName,
  sourceForBaseUrl,
  targetsForSource,
  type ProviderAuthResolver,
} from "../src/registry.js";

const EMPTY_CONFIG: QuotaConfig = { ark: { accounts: [] } };

function configWithArk(cookie: string): QuotaConfig {
  return { ark: { accounts: [{ id: "ark-a", provider: "volcengine", cookie }] } };
}

/** 返回固定凭据解析结果的假 resolver。 */
function resolverReturning(
  result: { auth?: { apiKey?: string } } | undefined,
): ProviderAuthResolver {
  return { getProviderAuth: async () => result };
}

/** 把 globalThis.fetch 换成一个「被调用即计数」的桩，结束后还原。 */
function stubFetch(t: test.TestContext): () => number {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("stub fetch 不应被调用");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return () => calls;
}

test("sourceForBaseUrl：三个官方 host 命中", () => {
  assert.equal(sourceForBaseUrl("https://ark.cn-beijing.volces.com/api/coding/v3"), "ark");
  assert.equal(sourceForBaseUrl("https://opencode.ai/zen/go/v1"), "opencode");
  assert.equal(sourceForBaseUrl("https://api.deepseek.com"), "deepseek");
});

test("sourceForBaseUrl：未知 host / 相似域名 / 非法输入一律 undefined", () => {
  assert.equal(sourceForBaseUrl("https://api.openai.com/v1"), undefined);
  // 必须精确 host 匹配：相似域名不得误命中
  assert.equal(sourceForBaseUrl("https://evil-opencode.ai/v1"), undefined);
  assert.equal(sourceForBaseUrl("https://opencode.ai.evil.com/v1"), undefined);
  assert.equal(sourceForBaseUrl("https://sub.api.deepseek.com"), undefined);
  assert.equal(sourceForBaseUrl("not a url"), undefined);
  assert.equal(sourceForBaseUrl(undefined), undefined);
  assert.equal(sourceForBaseUrl(""), undefined);
});

test("arkDisplayName：由账号 id 派生展示名", () => {
  assert.equal(arkDisplayName("ark-a"), "Ark-A");
  assert.equal(arkDisplayName("ark-b2"), "Ark-B2");
  assert.equal(arkDisplayName("ark"), "Ark");
});

test("targetsForSource(ark)：返回全部已配置账号，顺序与配置一致", () => {
  const config: QuotaConfig = {
    ark: {
      accounts: [
        { id: "ark-a", provider: "volcengine", cookie: "cookie-a" },
        { id: "ark-b", provider: "volcengine-2", cookie: "cookie-b" },
      ],
    },
  };
  const targets = targetsForSource("ark", "volcengine", {
    auth: resolverReturning(undefined),
    config,
  });
  assert.equal(targets.length, 2, "两个账号都要成为查询目标（多账号并排的前提）");
  assert.deepEqual(
    targets.map((target) => target.accountId),
    ["ark-a", "ark-b"],
  );
  assert.deepEqual(
    targets.map((target) => target.displayName),
    ["Ark-A", "Ark-B"],
  );
  assert.deepEqual(
    targets.map((target) => target.sourceId),
    ["ark", "ark"],
  );
});

test("targetsForSource(ark)：cookie 为空的槽位返回 missing-credential，且不发请求", async (t) => {
  const calls = stubFetch(t);
  const targets = targetsForSource("ark", "volcengine", {
    auth: resolverReturning(undefined),
    config: configWithArk(""),
  });
  assert.equal(targets.length, 1);
  const report = await targets[0]!.query();
  assert.equal(report.error?.code, "missing-credential");
  assert.equal(report.displayName, "Ark-A");
  assert.equal(report.sourceId, "ark");
  assert.equal(calls(), 0, "空凭据时不得发起网络请求");
});

test("targetsForSource(opencode)：pi 未返回 key → missing-credential，且不发请求", async (t) => {
  const calls = stubFetch(t);
  const targets = targetsForSource("opencode", "opencode-go-ds", {
    auth: resolverReturning(undefined),
    config: EMPTY_CONFIG,
  });
  assert.equal(targets.length, 1);
  const report = await targets[0]!.query();
  assert.equal(report.error?.code, "missing-credential");
  assert.equal(report.displayName, "Zen");
  assert.equal(calls(), 0, "无 key 时不得发起网络请求");
});

test("targetsForSource(deepseek)：空 apiKey → missing-credential，且不发请求", async (t) => {
  const calls = stubFetch(t);
  const targets = targetsForSource("deepseek", "deepseek", {
    auth: resolverReturning({ auth: { apiKey: "" } }),
    config: EMPTY_CONFIG,
  });
  assert.equal(targets.length, 1);
  const report = await targets[0]!.query();
  assert.equal(report.error?.code, "missing-credential");
  assert.equal(report.kind, "balance");
  assert.equal(calls(), 0, "空 key 时不得发起网络请求");
});

test("targetsForSource(ark)：未配置任何账号时返回空数组（footer 随即清空）", () => {
  const targets = targetsForSource("ark", "volcengine", {
    auth: resolverReturning(undefined),
    config: EMPTY_CONFIG,
  });
  assert.deepEqual(targets, []);
});

test("targetsForSource：凭据解析延迟到 query()，组装阶段不调用 getProviderAuth", () => {
  let resolveCalls = 0;
  const auth: ProviderAuthResolver = {
    getProviderAuth: async () => {
      resolveCalls += 1;
      return undefined;
    },
  };
  targetsForSource("opencode", "p", { auth, config: EMPTY_CONFIG });
  assert.equal(resolveCalls, 0, "组装阶段不得解析凭据（否则 /quota all 会因单个 provider 未登录而整体失败）");
});
