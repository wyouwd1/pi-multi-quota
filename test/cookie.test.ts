/**
 * src/cookie.test.ts —— Ark cookie 解析的单元测试。
 *
 * 所有值都是手工构造的**假**数据（SPEC §12 禁止真实凭据进入仓库）。
 * 只测纯函数，不发网络请求。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArkCookie, describeExpiry, type CookieParseResult } from "../src/cookie.js";

/** 假的 exp：与 SPEC §2.3 的实测样例同一个数量级（epoch 秒）。 */
const EXP_SECONDS = 2_000_000_000;
const EXP_MS = EXP_SECONDS * 1000;
/** 距 exp 恰好还剩 3 小时 12 分。 */
const NOW_MS = EXP_MS - (3 * 3_600_000 + 12 * 60_000);

const FAKE_CSRF = "fake-csrf-token-0001";
const FAKE_ACCOUNT_ID = "1234567890";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** 手工拼一个三段式假 JWT；签名段是占位符，从不验签。 */
function fakeJwt(payloadJson: string): string {
  return `${b64url('{"alg":"RS256","typ":"JWT"}')}.${b64url(payloadJson)}.ZmFrZS1zaWduYXR1cmU`;
}

const FAKE_DIGEST = fakeJwt(`{"exp":${EXP_SECONDS},"sub":"fake"}`);

function cookieOf(...segments: string[]): string {
  return segments.join("; ");
}

const FULL_COOKIE = cookieOf(
  "locale=zh-CN",
  "junk-without-equals",
  `csrfToken=${FAKE_CSRF}`,
  `AccountID=${FAKE_ACCOUNT_ID}`,
  `digest=${FAKE_DIGEST}`,
  "trail=1",
);

/** 取解析失败的结果；成功则直接让测试失败。 */
function expectFailure(raw: string, now: number = NOW_MS): Extract<CookieParseResult, { ok: false }> {
  const result = parseArkCookie(raw, now);
  if (result.ok) assert.fail("期望解析失败，实际成功");
  return result;
}

describe("parseArkCookie —— 成功路径", () => {
  it("从完整 cookie 提取 csrfToken / AccountID / exp 与剩余毫秒", () => {
    const result = parseArkCookie(FULL_COOKIE, NOW_MS);
    assert.ok(result.ok, "完整 cookie 应解析成功");
    assert.equal(result.value.csrfToken, FAKE_CSRF);
    assert.equal(result.value.accountId, FAKE_ACCOUNT_ID);
    assert.equal(result.value.digestExpMs, EXP_MS);
    assert.equal(result.value.expiresInMs, 11_520_000);
  });

  it("缺 AccountID 时仍成功，accountId 为 undefined", () => {
    const raw = cookieOf(`csrfToken=${FAKE_CSRF}`, `digest=${FAKE_DIGEST}`);
    const result = parseArkCookie(raw, NOW_MS);
    assert.ok(result.ok, "AccountID 非必需");
    assert.equal(result.value.accountId, undefined);
  });

  it("cookie 值被双引号包裹时同样能解析", () => {
    const raw = cookieOf(`csrfToken="${FAKE_CSRF}"`, `digest="${FAKE_DIGEST}"`);
    const result = parseArkCookie(raw, NOW_MS);
    assert.ok(result.ok, "带引号的 cookie 值应解析成功");
    assert.equal(result.value.csrfToken, FAKE_CSRF);
    assert.equal(result.value.digestExpMs, EXP_MS);
  });

  it("已过期的 digest 仍算解析成功，expiresInMs 为负", () => {
    const raw = cookieOf(`csrfToken=${FAKE_CSRF}`, `digest=${FAKE_DIGEST}`);
    const result = parseArkCookie(raw, EXP_MS + 20 * 60_000);
    assert.ok(result.ok, "过期不是解析错误");
    assert.equal(result.value.expiresInMs, -1_200_000);
  });

  it("重复键取最后一个", () => {
    const raw = cookieOf(
      `csrfToken=first-csrf`,
      `AccountID=111`,
      `digest=${fakeJwt('{"exp":1}')}.extra-segment`,
      `csrfToken=first-csrf-again`,
      `csrfToken=${FAKE_CSRF}`,
      `AccountID=${FAKE_ACCOUNT_ID}`,
      `digest=${FAKE_DIGEST}`,
    );
    const result = parseArkCookie(raw, NOW_MS);
    assert.ok(result.ok, "最后一个 digest 合法即应成功");
    assert.equal(result.value.csrfToken, FAKE_CSRF);
    assert.equal(result.value.accountId, FAKE_ACCOUNT_ID);
    assert.equal(result.value.digestExpMs, EXP_MS);
  });
});

describe("parseArkCookie —— 失败路径", () => {
  it("缺 csrfToken → missing-csrf", () => {
    const raw = cookieOf(`AccountID=${FAKE_ACCOUNT_ID}`, `digest=${FAKE_DIGEST}`);
    assert.equal(expectFailure(raw).code, "missing-csrf");
  });

  it("csrfToken 为空值 → missing-csrf", () => {
    const raw = cookieOf(`csrfToken=`, `digest=${FAKE_DIGEST}`);
    assert.equal(expectFailure(raw).code, "missing-csrf");
  });

  it("缺 digest → missing-digest", () => {
    const raw = cookieOf(`csrfToken=${FAKE_CSRF}`, `AccountID=${FAKE_ACCOUNT_ID}`);
    assert.equal(expectFailure(raw).code, "missing-digest");
  });

  it("digest 只有两段 → malformed-digest", () => {
    const raw = cookieOf(`csrfToken=${FAKE_CSRF}`, `digest=${b64url('{"exp":1}')}.ZmFrZQ`);
    assert.equal(expectFailure(raw).code, "malformed-digest");
  });

  it("digest 有四段 → malformed-digest", () => {
    const raw = cookieOf(`csrfToken=${FAKE_CSRF}`, `digest=a.${b64url('{"exp":1}')}.c.d`);
    assert.equal(expectFailure(raw).code, "malformed-digest");
  });

  it("payload 含非 base64url 字符 → malformed-digest", () => {
    const raw = cookieOf(`csrfToken=${FAKE_CSRF}`, `digest=aGVhZGVy.{"exp":1}.c2ln`);
    assert.equal(expectFailure(raw).code, "malformed-digest");
  });

  it("payload 不是 JSON → malformed-digest", () => {
    const raw = cookieOf(`csrfToken=${FAKE_CSRF}`, `digest=head.${b64url("not json")}.sig`);
    assert.equal(expectFailure(raw).code, "malformed-digest");
  });

  it("payload 缺 exp → malformed-digest", () => {
    const raw = cookieOf(`csrfToken=${FAKE_CSRF}`, `digest=${fakeJwt('{"sub":"fake"}')}`);
    assert.equal(expectFailure(raw).code, "malformed-digest");
  });

  it("exp 不是数字 → malformed-digest", () => {
    const raw = cookieOf(`csrfToken=${FAKE_CSRF}`, `digest=${fakeJwt('{"exp":"2000000000"}')}`);
    assert.equal(expectFailure(raw).code, "malformed-digest");
  });

  it("payload 是 JSON 数组 → malformed-digest", () => {
    const raw = cookieOf(`csrfToken=${FAKE_CSRF}`, `digest=${fakeJwt("[1,2,3]")}`);
    assert.equal(expectFailure(raw).code, "malformed-digest");
  });

  it("空串 → missing-csrf", () => {
    assert.equal(expectFailure("").code, "missing-csrf");
  });

  it("失败结果只含错误码与短句，不回显 cookie 原文", () => {
    const cases = [
      cookieOf(`AccountID=${FAKE_ACCOUNT_ID}`, `digest=${FAKE_DIGEST}`),
      cookieOf(`csrfToken=${FAKE_CSRF}`),
      cookieOf(`csrfToken=${FAKE_CSRF}`, `digest=head.${b64url("not json")}.sig`),
    ];
    for (const raw of cases) {
      const failure = expectFailure(raw);
      assert.notEqual(failure.message, "");
      assert.equal(failure.message.includes(raw), false, "message 不得回显 cookie 原文");
      assert.equal(failure.message.includes(FAKE_CSRF), false, "message 不得包含 csrfToken 值");
      assert.equal(failure.message.includes(FAKE_DIGEST), false, "message 不得包含 digest 值");
      assert.equal(failure.message.includes(FAKE_ACCOUNT_ID), false, "message 不得包含 AccountID 值");
    }
  });
});

describe("describeExpiry", () => {
  const cases: Array<[number, string]> = [
    [11_520_000, "3 小时 12 分"],
    [3 * 3_600_000, "3 小时"],
    [20 * 60_000, "20 分钟"],
    [30_000, "<1 分钟"],
    [0, "<1 分钟"],
    [-1_200_000, "已过期 20 分钟"],
    [-30_000, "已过期 <1 分钟"],
    [26 * 3_600_000, "1 天 2 小时"],
    [48 * 3_600_000, "2 天"],
    [-50 * 3_600_000, "已过期 2 天 2 小时"],
  ];

  for (const [ms, expected] of cases) {
    it(`${ms} ms → "${expected}"`, () => {
      assert.equal(describeExpiry(ms), expected);
    });
  }
});
