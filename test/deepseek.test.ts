/**
 * DeepSeek 适配器测试。
 * 覆盖：SPEC §2.2 同源响应结构（结构为实测所得，数值已合成）、金额字符串精度、多币种、不可用 / 空数组分支、注入 fetch 的失败分支与脱敏。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEEPSEEK_ACCOUNT_ID,
  DEEPSEEK_BALANCE_URL,
  fetchDeepSeekBalance,
  parseDeepSeekBalance,
} from "../src/sources/deepseek.js";
import type { AccountReport, BalanceEntry } from "../src/types.js";

const FETCHED_AT = 1_760_000_000_000;
const API_KEY = "sk-deepseek-test-0123456789abcdef";

/** SPEC §2.2 响应结构（结构为实测所得，数值已合成）。 */
const SPEC_SAMPLE = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "1234.56",
      granted_balance: "0.00",
      topped_up_balance: "1234.56",
    },
  ],
};

function balanceAt(report: AccountReport, index: number): BalanceEntry {
  const entry = report.balances?.[index];
  assert.ok(entry, `期望存在第 ${index} 条余额记录`);
  return entry;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("fetchDeepSeekBalance: 用 Bearer 鉴权请求固定端点，正常响应解析出余额", async () => {
  let seenUrl = "";
  let seenAuth: string | null = null;
  const fakeFetch: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenAuth = new Headers(init?.headers).get("authorization");
    return jsonResponse(SPEC_SAMPLE);
  };

  const report = await fetchDeepSeekBalance(API_KEY, { fetchImpl: fakeFetch });

  assert.equal(seenUrl, DEEPSEEK_BALANCE_URL);
  assert.equal(seenAuth, `Bearer ${API_KEY}`);
  assert.equal(report.error, undefined);
  assert.equal(balanceAt(report, 0).total, "1234.56");
});

// ---------------------------------------------------------------------------
// 纯解析
// ---------------------------------------------------------------------------

test("parseDeepSeekBalance: 样例身份字段符合契约", () => {
  const report = parseDeepSeekBalance(SPEC_SAMPLE, FETCHED_AT);

  assert.equal(report.accountId, DEEPSEEK_ACCOUNT_ID);
  assert.equal(report.displayName, "DeepSeek");
  assert.equal(report.sourceId, "deepseek");
  assert.equal(report.kind, "balance");
  assert.equal(report.fetchedAt, FETCHED_AT);
  assert.equal(report.error, undefined);
  assert.equal(report.balances?.length, 1);
});

test("parseDeepSeekBalance: CNY 余额保持字符串 \"1234.56\"，未转成 Number", () => {
  const report = parseDeepSeekBalance(SPEC_SAMPLE, FETCHED_AT);
  const cny = balanceAt(report, 0);

  assert.equal(cny.currency, "CNY");
  assert.equal(cny.total, "1234.56");
  assert.equal(typeof cny.total, "string", "金额必须是字符串");
  assert.equal(cny.granted, "0.00");
  assert.equal(cny.toppedUp, "1234.56");
  // 合成值 1234.56 不具备尾零特性，因此改用同一响应体里 §8 明确「不动」的 granted "0.00"
  // 来验证「未经 Number 转换」这一命题（合成前的样例值靠小数末位 0 证明同一件事）。
  assert.ok(cny.granted.endsWith("0"), "小数末位 0 必须保留");
  assert.ok(String(Number(cny.granted)) !== cny.granted, "字符串不应等于 Number 往返结果");
});

test("parseDeepSeekBalance: 大额金额不做 float 往返", () => {
  const report = parseDeepSeekBalance(
    {
      is_available: true,
      balance_infos: [
        {
          currency: "USD",
          total_balance: "12345678901234567.89",
          granted_balance: "0.01",
          topped_up_balance: "12345678901234567.88",
        },
      ],
    },
    FETCHED_AT,
  );

  const usd = balanceAt(report, 0);
  assert.equal(usd.total, "12345678901234567.89");
  assert.equal(usd.toppedUp, "12345678901234567.88");
  assert.notEqual(String(Number(usd.total)), usd.total, "转 Number 应被视为精度损失（本用例用于证明未转换）");
});

test("parseDeepSeekBalance: 多币种各自一条，不相加不换算", () => {
  const report = parseDeepSeekBalance(
    {
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "1234.56", granted_balance: "0.00", topped_up_balance: "1234.56" },
        { currency: "USD", total_balance: "12.30", granted_balance: "2.30", topped_up_balance: "10.00" },
      ],
    },
    FETCHED_AT,
  );

  assert.equal(report.balances?.length, 2);
  assert.deepEqual(
    report.balances?.map((entry) => entry.currency),
    ["CNY", "USD"],
  );
  assert.equal(balanceAt(report, 0).total, "1234.56");
  assert.equal(balanceAt(report, 1).total, "12.30");
  assert.equal(balanceAt(report, 1).granted, "2.30");
});

test("parseDeepSeekBalance: is_available=false → 带 error 且不展示余额", () => {
  const report = parseDeepSeekBalance({ is_available: false, balance_infos: [] }, FETCHED_AT);

  assert.equal(report.kind, "balance");
  assert.equal(report.balances, undefined, "不可用时不得展示余额");
  const error = report.error;
  assert.ok(error, "账户不可用必须带 error");
  assert.equal(error.code, "http-402");
  assert.match(error.message, /不可用/);
});

test("parseDeepSeekBalance: balance_infos 为空数组 → 报错，不显示 ¥0.00", () => {
  const report = parseDeepSeekBalance({ is_available: true, balance_infos: [] }, FETCHED_AT);

  assert.equal(report.balances, undefined);
  const error = report.error;
  assert.ok(error, "空数组必须带 error");
  assert.equal(error.code, "unknown-shape");
  assert.ok(!/0\.00/.test(error.message));
});

test("parseDeepSeekBalance: payload 畸形 → unknown-shape，不抛异常", () => {
  const notObject = parseDeepSeekBalance("not-json", FETCHED_AT);
  assert.equal(notObject.error?.code, "unknown-shape");
  assert.equal(notObject.balances, undefined);

  const missingInfos = parseDeepSeekBalance({ is_available: true }, FETCHED_AT);
  assert.equal(missingInfos.error?.code, "unknown-shape");

  const badEntries = parseDeepSeekBalance(
    { is_available: true, balance_infos: [{ currency: "CNY" }, { total_balance: 123 }] },
    FETCHED_AT,
  );
  assert.equal(badEntries.error?.code, "unknown-shape");
});

test("parseDeepSeekBalance: 部分条目异常时保留可用条目并记 note", () => {
  const report = parseDeepSeekBalance(
    {
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "1234.56" }, { currency: "USD" }],
    },
    FETCHED_AT,
  );

  assert.equal(report.balances?.length, 1);
  assert.equal(report.error, undefined);
  assert.deepEqual(report.notes, ["1 条余额记录结构异常，已跳过"]);
});

// ---------------------------------------------------------------------------
// 网络层（注入假 fetch，不触网）
// ---------------------------------------------------------------------------

test("fetchDeepSeekBalance: 401 → http-401，message 脱敏", async () => {
  const fakeFetch: typeof fetch = async () => jsonResponse({ error: "Authentication Fails" }, 401);
  const report = await fetchDeepSeekBalance(API_KEY, { fetchImpl: fakeFetch });

  const error = report.error;
  assert.ok(error, "非 2xx 必须返回 error 报告");
  assert.equal(error.code, "http-401");
  assert.ok(!error.message.includes(API_KEY), "错误信息不得包含 apiKey");
  assert.ok(!error.message.includes("Authentication Fails"), "错误信息不得回显响应体");
  assert.equal(report.balances, undefined);
});

test("fetchDeepSeekBalance: 超时 → timeout，不抛异常", async () => {
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) return;
      const abort = () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });

  const report = await fetchDeepSeekBalance(API_KEY, { fetchImpl: hangingFetch, timeoutMs: 10 });

  const error = report.error;
  assert.ok(error, "超时必须返回 error 报告");
  assert.equal(error.code, "timeout");
  assert.ok(!error.message.includes(API_KEY));
});

test("fetchDeepSeekBalance: 网络异常 → network，不抛异常", async () => {
  const failingFetch: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const report = await fetchDeepSeekBalance(API_KEY, { fetchImpl: failingFetch });

  const error = report.error;
  assert.ok(error, "网络异常必须返回 error 报告");
  assert.equal(error.code, "network");
  assert.ok(!error.message.includes(API_KEY));
  assert.ok(!error.message.includes("fetch failed"), "错误信息不得包含底层异常原文");
});

test("fetchDeepSeekBalance: 200 但响应不是 JSON → unknown-shape", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response("<html>bad gateway</html>", { status: 200 });
  const report = await fetchDeepSeekBalance(API_KEY, { fetchImpl: fakeFetch });

  const error = report.error;
  assert.ok(error);
  assert.equal(error.code, "unknown-shape");
  assert.ok(!error.message.includes("<html>"), "错误信息不得包含响应体");
});

test("fetchDeepSeekBalance: 空 apiKey → missing-credential，且不发请求", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(SPEC_SAMPLE);
  };

  const report = await fetchDeepSeekBalance("", { fetchImpl: fakeFetch });

  assert.equal(calls, 0, "缺凭据时不得发请求");
  assert.equal(report.error?.code, "missing-credential");
});
