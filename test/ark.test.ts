/**
 * Ark 适配器测试。
 *
 * 覆盖：SPEC §2.3 响应结构的三个窗口（响应结构为实测所得，数值已合成）、HTTP 200 但 body 带 Error 的失败分支
 * （NotLogin / InvalidCSRFToken / 未知码）、结构不识别的降级、未知 Level 的容忍、
 * 请求构造（csrf 来自 cookie、body 为 {}、拒绝重定向）、host 白名单与错误信息脱敏。
 * 全程使用假 payload 与假 fetchImpl，不触网。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ARK_ALLOWED_HOST,
  ARK_USAGE_URL,
  fetchArkUsage,
  isArkAllowedUrl,
  parseArkUsage,
} from "../src/sources/ark.js";
import type { ArkAccountConfig } from "../src/config.js";
import type { AccountReport, QuotaWindow, WindowLevel } from "../src/types.js";

const FETCHED_AT = 1_760_000_000_000;

/** SPEC §2.3 成功响应结构（结构为实测所得，数值已合成；字段原样保留，用于验证不丢精度、不换算）。 */
const SPEC_SAMPLE = {
  ResponseMetadata: {
    RequestId: "0218999900001234abcdef",
    Action: "GetCodingPlanUsage",
    Version: "2024-01-01",
    Service: "ark",
    Region: "cn-beijing",
  },
  Result: {
    Status: "Running",
    UpdateTimestamp: 1899990000,
    QuotaUsage: [
      { Level: "session", Percent: 12.5, ResetTimestamp: 1900000000, Cap: 100, RewardTotalPercent: 0 },
      { Level: "weekly", Percent: 37.25, ResetTimestamp: 1900100000, Cap: 100, RewardTotalPercent: 0 },
      { Level: "monthly", Percent: 100, ResetTimestamp: 1900200000, Cap: 100, RewardTotalPercent: 0 },
    ],
    HasReward: false,
  },
};

const CSRF_TOKEN = "csrf-token-for-test-0123456789";
/** 合成占位账号 ID（非真实火山账号），仅用于拼装假 cookie 并验证凭据不泄漏。 */
const ACCOUNT_ID_IN_COOKIE = "1000000001";
/** 只需三段 JWT 形态 + 可解析的 exp，parseArkCookie 不验签。 */
const DIGEST = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(
  JSON.stringify({ exp: 1_800_000_000 }),
).toString("base64url")}.test-signature`;
const COOKIE = `csrfToken=${CSRF_TOKEN}; digest=${DIGEST}; AccountID=${ACCOUNT_ID_IN_COOKIE}`;
const ACCOUNT: ArkAccountConfig = { id: "ark-a", provider: "volcengine", cookie: COOKIE };
const SECRETS = [CSRF_TOKEN, DIGEST, COOKIE, ACCOUNT_ID_IN_COOKIE];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function windowOf(report: AccountReport, level: WindowLevel): QuotaWindow {
  const window = report.windows?.find((candidate) => candidate.level === level);
  assert.ok(window, `期望存在 ${level} 窗口`);
  return window;
}

/** 任何对外的错误文本都不得出现 cookie 原文片段。 */
function assertRedacted(report: AccountReport): void {
  const text = [report.error?.message ?? "", ...(report.notes ?? [])].join(" ");
  for (const secret of SECRETS) {
    assert.ok(!text.includes(secret), "错误信息泄漏了凭据片段（内容已省略，避免断言失败时反向泄漏）");
  }
}

/** NotLogin / InvalidCSRFToken 的失败响应样例（SPEC §2.3）。 */
const NOT_LOGIN_BODY = { ResponseMetadata: { Error: { Code: "NotLogin", Message: "Not logged in" } } };
const BAD_CSRF_BODY = {
  ResponseMetadata: { Error: { Code: "InvalidCSRFToken", Message: "Invalid CSRF token." } },
};

// ---------------------------------------------------------------------------
// 纯解析：成功路径
// ---------------------------------------------------------------------------

test("parseArkUsage: SPEC §2.3 样例解析出 session/weekly/monthly 三窗口", () => {
  const report = parseArkUsage(SPEC_SAMPLE, FETCHED_AT, "ark-a", "Ark-A");

  assert.equal(report.accountId, "ark-a");
  assert.equal(report.displayName, "Ark-A", "displayName 由调用方决定，必须原样使用");
  assert.equal(report.sourceId, "ark");
  assert.equal(report.kind, "windows");
  assert.equal(report.fetchedAt, FETCHED_AT);
  assert.equal(report.error, undefined);
  assert.equal(report.notes, undefined);

  assert.deepEqual(
    report.windows?.map((window) => window.level),
    ["session", "weekly", "monthly"],
  );
  assert.equal(windowOf(report, "session").percent, 12.5);
  assert.equal(windowOf(report, "weekly").percent, 37.25);
  assert.equal(windowOf(report, "monthly").percent, 100);
});

test("parseArkUsage: ResetTimestamp 是 epoch 秒，直接使用（不做 ms 换算）", () => {
  const report = parseArkUsage(SPEC_SAMPLE, FETCHED_AT, "ark-a", "Ark-A");

  assert.equal(windowOf(report, "session").resetsAt, 1900000000);
  assert.equal(windowOf(report, "weekly").resetsAt, 1900100000);
  assert.equal(windowOf(report, "monthly").resetsAt, 1900200000);
  assert.ok(windowOf(report, "monthly").resetsAt! < FETCHED_AT, "若误按 ms 处理会大于 fetchedAt");
});

test("parseArkUsage: monthly 100% 原样保留，不裁剪也不四舍五入", () => {
  const report = parseArkUsage(SPEC_SAMPLE, FETCHED_AT, "ark-a", "Ark-A");

  assert.equal(windowOf(report, "monthly").percent, 100);
  assert.equal(windowOf(report, "session").percent % 1 !== 0, true, "小数百分比必须保留小数");
});

test("parseArkUsage: 未知 Level 跳过并记 note，其余窗口照常解析", () => {
  const report = parseArkUsage(
    {
      Result: {
        QuotaUsage: [
          { Level: "rolling", Percent: 9, ResetTimestamp: 1900000000 },
          { Level: "weekly", Percent: 8.5, ResetTimestamp: 1900100000 },
          { Level: 42, Percent: 1, ResetTimestamp: 1 },
        ],
      },
    },
    FETCHED_AT,
    "ark-b",
    "Ark-B",
  );

  assert.equal(report.error, undefined, "单个未知窗口不得让整段失败");
  assert.deepEqual(
    report.windows?.map((window) => window.level),
    ["weekly"],
  );
  assert.equal(report.notes?.length, 2);
  assert.match(report.notes?.join(" ") ?? "", /rolling/);
  assertRedacted(report);
});

test("parseArkUsage: 重复 Level 与非法 Percent 跳过并记 note", () => {
  const report = parseArkUsage(
    {
      Result: {
        QuotaUsage: [
          { Level: "session", Percent: 6, ResetTimestamp: 100 },
          { Level: "session", Percent: 7, ResetTimestamp: 200 },
          { Level: "monthly", Percent: "100", ResetTimestamp: 300 },
        ],
      },
    },
    FETCHED_AT,
    "ark-a",
    "Ark-A",
  );

  assert.deepEqual(
    report.windows?.map((window) => window.level),
    ["session"],
  );
  assert.equal(windowOf(report, "session").percent, 6);
  assert.equal(report.notes?.length, 2);
});

test("parseArkUsage: ResetTimestamp 缺失时窗口保留但无 resetsAt", () => {
  const report = parseArkUsage(
    { Result: { QuotaUsage: [{ Level: "session", Percent: 6 }] } },
    FETCHED_AT,
    "ark-a",
    "Ark-A",
  );

  assert.equal(report.error, undefined);
  assert.equal(report.windows?.length, 1);
  assert.equal(windowOf(report, "session").resetsAt, undefined);
});

// ---------------------------------------------------------------------------
// 纯解析：HTTP 200 但 body 带 Error（最容易写错的分支）
// ---------------------------------------------------------------------------

test("parseArkUsage: ResponseMetadata.Error.Code=NotLogin → code NotLogin", () => {
  const report = parseArkUsage(NOT_LOGIN_BODY, FETCHED_AT, "ark-a", "Ark-A");

  const error = report.error;
  assert.ok(error, "body 带 Error 即是失败，不能只看 HTTP 200");
  assert.equal(error.code, "NotLogin");
  assert.equal(error.message, "cookie 已过期或无效");
  assert.ok(!error.message.includes("Not logged in"), "不得回显响应体原文");
  assert.equal(report.windows, undefined, "失败时不得输出任何窗口");
  assertRedacted(report);
});

test("parseArkUsage: ResponseMetadata.Error.Code=InvalidCSRFToken → code InvalidCSRFToken", () => {
  const report = parseArkUsage(BAD_CSRF_BODY, FETCHED_AT, "ark-a", "Ark-A");

  const error = report.error;
  assert.ok(error);
  assert.equal(error.code, "InvalidCSRFToken");
  assert.equal(error.message, "cookie 不完整");
  assert.ok(!error.message.includes("Invalid CSRF token."), "不得回显响应体原文");
  assertRedacted(report);
});

test("parseArkUsage: 未知 Error.Code 归入 unknown-shape，原始 code 降级进 notes", () => {
  const report = parseArkUsage(
    {
      ResponseMetadata: {
        Error: { Code: "Throttling", Message: `rate limit exceeded for cookie ${COOKIE}` },
      },
    },
    FETCHED_AT,
    "ark-a",
    "Ark-A",
  );

  const error = report.error;
  assert.ok(error);
  assert.equal(error.code, "unknown-shape", "未知 code 不得进入 QuotaError.code（§1.3 码表之外）");
  assert.equal(error.message, "接口变更");
  assert.ok(
    (report.notes ?? []).some((note) => note.includes("Throttling")),
    "原始 code 应降级保留到 notes 供排查",
  );
  assertRedacted(report);
});

test("parseArkUsage: 既无 Error 也无可用 QuotaUsage → unknown-shape", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["字符串", "not-json"],
    ["空对象", {}],
    ["Result 缺失", { ResponseMetadata: {} }],
    ["QuotaUsage 非数组", { Result: { QuotaUsage: {} } }],
    ["QuotaUsage 空数组", { Result: { QuotaUsage: [] } }],
    ["全是不认识的 Level", { Result: { QuotaUsage: [{ Level: "hourly", Percent: 1 }] } }],
  ];

  for (const [label, payload] of cases) {
    const report = parseArkUsage(payload, FETCHED_AT, "ark-a", "Ark-A");
    assert.equal(report.error?.code, "unknown-shape", `${label} 应判为 unknown-shape`);
    assert.equal(report.error?.message, "接口变更");
    assert.equal(report.windows, undefined);
    assertRedacted(report);
  }
});

// ---------------------------------------------------------------------------
// 网络层（注入假 fetch，不触网）
// ---------------------------------------------------------------------------

test("fetchArkUsage: POST 固定端点，x-csrf-token 取自 cookie 内联，body 为 {}", async () => {
  let seenUrl = "";
  let seenMethod = "";
  let seenHeaders: Headers | undefined;
  let seenBody: unknown;
  let seenRedirect: string | undefined;

  const fakeFetch: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenMethod = init?.method ?? "";
    seenHeaders = new Headers(init?.headers);
    seenBody = init?.body;
    seenRedirect = init?.redirect;
    return jsonResponse(SPEC_SAMPLE);
  };

  const report = await fetchArkUsage(ACCOUNT, { fetchImpl: fakeFetch });

  assert.equal(seenUrl, ARK_USAGE_URL);
  assert.equal(seenMethod, "POST");
  assert.equal(seenHeaders?.get("x-csrf-token"), CSRF_TOKEN, "csrf 必须来自 cookie 解析结果");
  assert.equal(seenHeaders?.get("content-type"), "application/json");
  assert.equal(seenBody, "{}");
  assert.equal(seenRedirect, "error", "必须拒绝重定向，防止凭据被转发");

  assert.equal(report.error, undefined);
  assert.equal(report.accountId, "ark-a");
  assert.equal(report.sourceId, "ark");
  assert.equal(report.kind, "windows");
  assert.equal(windowOf(report, "monthly").percent, 100);
});

test("fetchArkUsage: displayName 由 account.id 派生（ark-a → Ark-A）", async () => {
  const fakeFetch: typeof fetch = async () => jsonResponse(SPEC_SAMPLE);

  const a = await fetchArkUsage(ACCOUNT, { fetchImpl: fakeFetch });
  const b = await fetchArkUsage({ ...ACCOUNT, id: "ark-b" }, { fetchImpl: fakeFetch });

  assert.equal(a.displayName, "Ark-A");
  assert.equal(b.displayName, "Ark-B");
});

test("fetchArkUsage: HTTP 200 + NotLogin → code NotLogin，不回显 cookie 与响应体", async () => {
  const fakeFetch: typeof fetch = async () => jsonResponse(NOT_LOGIN_BODY);

  const report = await fetchArkUsage(ACCOUNT, { fetchImpl: fakeFetch });

  assert.equal(report.error?.code, "NotLogin");
  assert.equal(report.windows, undefined);
  assertRedacted(report);
});

test("fetchArkUsage: HTTP 200 + InvalidCSRFToken → code InvalidCSRFToken", async () => {
  const fakeFetch: typeof fetch = async () => jsonResponse(BAD_CSRF_BODY);

  const report = await fetchArkUsage(ACCOUNT, { fetchImpl: fakeFetch });

  assert.equal(report.error?.code, "InvalidCSRFToken");
  assertRedacted(report);
});

test("fetchArkUsage: cookie 缺少 csrfToken → InvalidCSRFToken，且不发请求", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(SPEC_SAMPLE);
  };

  const report = await fetchArkUsage(
    { ...ACCOUNT, cookie: `digest=${DIGEST}; AccountID=${ACCOUNT_ID_IN_COOKIE}` },
    { fetchImpl: fakeFetch },
  );

  assert.equal(calls, 0, "cookie 解析失败时不得发请求");
  assert.equal(report.error?.code, "InvalidCSRFToken");
  assertRedacted(report);
});

test("fetchArkUsage: cookie 为空 → missing-credential，且不发请求", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(SPEC_SAMPLE);
  };

  const report = await fetchArkUsage({ ...ACCOUNT, cookie: "   " }, { fetchImpl: fakeFetch });

  assert.equal(calls, 0, "缺凭据时不得发请求");
  assert.equal(report.error?.code, "missing-credential");
  assertRedacted(report);
});

test("fetchArkUsage: 非 2xx → http-<status>", async () => {
  const fakeFetch: typeof fetch = async () => new Response("boom", { status: 500 });

  const report = await fetchArkUsage(ACCOUNT, { fetchImpl: fakeFetch });

  assert.equal(report.error?.code, "http-500");
  assert.ok(!(report.error?.message ?? "").includes("boom"), "不得回显响应体");
  assertRedacted(report);
});

test("fetchArkUsage: 200 但响应不是 JSON → unknown-shape", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response("<html>bad gateway</html>", { status: 200 });

  const report = await fetchArkUsage(ACCOUNT, { fetchImpl: fakeFetch });

  assert.equal(report.error?.code, "unknown-shape");
  assert.ok(!(report.error?.message ?? "").includes("<html>"), "不得回显响应体");
  assertRedacted(report);
});

test("fetchArkUsage: 超时 → timeout，不抛异常", async () => {
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) return;
      const abort = (): void => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });

  const report = await fetchArkUsage(ACCOUNT, { fetchImpl: hangingFetch, timeoutMs: 10 });

  assert.equal(report.error?.code, "timeout");
  assertRedacted(report);
});

test("fetchArkUsage: 网络异常 → network，不抛异常", async () => {
  const failingFetch: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };

  const report = await fetchArkUsage(ACCOUNT, { fetchImpl: failingFetch });

  assert.equal(report.error?.code, "network");
  assert.ok(!(report.error?.message ?? "").includes("fetch failed"), "不得回显底层异常原文");
  assertRedacted(report);
});

test("fetchArkUsage: 重定向被拒绝时（fetch 抛错）降级为 network，不泄漏凭据", async () => {
  // redirect: "error" 由运行时实现，假 fetch 模拟运行时抛出的重定向错误
  const redirectingFetch: typeof fetch = async () => {
    throw new TypeError("unexpected redirect");
  };

  const report = await fetchArkUsage(ACCOUNT, { fetchImpl: redirectingFetch });

  assert.equal(report.error?.code, "network");
  assertRedacted(report);
});

// ---------------------------------------------------------------------------
// host 白名单
// ---------------------------------------------------------------------------

test("isArkAllowedUrl: 只放行 ARK_ALLOWED_HOST", () => {
  assert.equal(isArkAllowedUrl(ARK_USAGE_URL), true, "契约常量本身必须合法");
  assert.equal(new URL(ARK_USAGE_URL).host, ARK_ALLOWED_HOST);

  assert.equal(isArkAllowedUrl("https://evil.example.com/api/top/ark"), false);
  assert.equal(isArkAllowedUrl(`https://${ARK_ALLOWED_HOST}.evil.example.com/x`), false, "后缀伪装必须拦住");
  assert.equal(isArkAllowedUrl(`https://${ARK_ALLOWED_HOST}:8443/x`), false, "带端口不等价");
  assert.equal(isArkAllowedUrl("not-a-url"), false, "不可解析按不通过处理");
});

test("fetchArkUsage: 发送前先过 host 白名单（常量合法 ⇒ 正常发出）", async () => {
  // ARK_USAGE_URL 是模块常量，blocked-host 分支无法在测试中直接触发；
  // 此处验证门禁本身 + 实际请求 URL，两者合起来覆盖「先校验再发送」的实现。
  let seenUrl = "";
  const fakeFetch: typeof fetch = async (input) => {
    seenUrl = String(input);
    return jsonResponse(SPEC_SAMPLE);
  };

  assert.equal(isArkAllowedUrl(ARK_USAGE_URL), true);
  await fetchArkUsage(ACCOUNT, { fetchImpl: fakeFetch });
  assert.equal(new URL(seenUrl).host, ARK_ALLOWED_HOST);
});
