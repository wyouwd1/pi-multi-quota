/**
 * OpenCode Go 适配器测试：纯解析 + 注入 fetch 的网络分支。
 *
 * 全部使用占位凭据，不发真实网络请求（SPEC §11）。
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  OPENCODE_ACCOUNT_ID,
  OPENCODE_USAGE_URL,
  fetchOpenCodeUsage,
  parseOpenCodeUsage,
  type FetchOptions,
} from "../src/sources/opencode.js";

/** 占位凭据，不是真实 API key。 */
const TEST_API_KEY = "test-key-not-a-real-credential";

/** SPEC §2.1 响应结构（结构为实测所得，数值已合成），每次调用返回新对象，避免用例间互相污染。 */
function specPayload(): unknown {
  return {
    usage: {
      rolling: { status: "ok", percent: 12, resetsAt: "2027-01-15T09:12:05.000Z" },
      weekly: { status: "ok", percent: 34, resetsAt: "2027-01-21T00:00:00.000Z" },
      monthly: { status: "ok", percent: 56, resetsAt: "2027-01-18T11:45:30.000Z" },
    },
  };
}

/** 按 handler 构造可注入的 fetch 假实现。 */
function fakeFetch(handler: (init: RequestInit) => Promise<Response> | Response): typeof fetch {
  return async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => handler(init ?? {});
}

/** JSON 响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 永不返回的响应，只在收到 abort 时以 AbortError 拒答。 */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const fail = (): void => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    const signal = init?.signal;
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener("abort", fail, { once: true });
  });

describe("parseOpenCodeUsage", () => {
  test("SPEC 样例：三窗口 percent 与 epoch 秒重置时间正确", () => {
    const fetchedAt = 1789450000000;
    const report = parseOpenCodeUsage(specPayload(), fetchedAt);

    assert.deepEqual(report.windows, [
      { level: "session", percent: 12, resetsAt: 1800004325 },
      { level: "weekly", percent: 34, resetsAt: 1800489600 },
      { level: "monthly", percent: 56, resetsAt: 1800272730 },
    ]);
    assert.equal(report.fetchedAt, fetchedAt);
    assert.equal(report.notes, undefined);
  });

  test("顶层元信息固定：Zen / opencode / windows", () => {
    const report = parseOpenCodeUsage(specPayload(), 1);

    assert.equal(report.accountId, OPENCODE_ACCOUNT_ID);
    assert.equal(report.accountId, "opencode");
    assert.equal(report.displayName, "Zen");
    assert.equal(report.sourceId, "opencode");
    assert.equal(report.kind, "windows");
    assert.equal(report.error, undefined);
  });

  test("rate-limited 窗口保留可见", () => {
    const payload = specPayload() as { usage: Record<string, unknown> };
    payload.usage.rolling = { status: "rate-limited", percent: 100, resetsAt: "2027-01-15T09:12:05.000Z" };

    const report = parseOpenCodeUsage(payload, 1);

    assert.deepEqual(report.windows?.[0], { level: "session", percent: 100, resetsAt: 1800004325 });
    assert.equal(report.notes, undefined);
  });

  test("未知 status：跳过该窗口、写入 notes、不抛异常", () => {
    const payload = specPayload() as { usage: Record<string, unknown> };
    payload.usage.weekly = { status: "degraded", percent: 34, resetsAt: "2027-01-21T00:00:00.000Z" };

    const report = parseOpenCodeUsage(payload, 1);

    assert.deepEqual(
      report.windows?.map((w) => w.level),
      ["session", "monthly"],
    );
    assert.equal(report.notes?.length, 1);
    assert.match(report.notes?.[0] ?? "", /weekly/);
    assert.match(report.notes?.[0] ?? "", /degraded/);
  });

  test("status 缺失或非字符串同样降级为 note", () => {
    const payload = specPayload() as { usage: Record<string, unknown> };
    payload.usage.rolling = { percent: 12 };
    payload.usage.weekly = { status: 42, percent: 34 };

    const report = parseOpenCodeUsage(payload, 1);

    assert.deepEqual(
      report.windows?.map((w) => w.level),
      ["monthly"],
    );
    assert.equal(report.notes?.length, 2);
  });

  test("percent 非法（负数 / NaN / Infinity / 字符串 / 缺失）的窗口被跳过", () => {
    const badPercents: unknown[] = [-1, Number.NaN, Number.POSITIVE_INFINITY, "9", undefined];
    for (const bad of badPercents) {
      const payload = specPayload() as { usage: Record<string, unknown> };
      payload.usage.rolling = { status: "ok", percent: bad };

      const report = parseOpenCodeUsage(payload, 1);

      assert.deepEqual(
        report.windows?.map((w) => w.level),
        ["weekly", "monthly"],
        `percent=${String(bad)} 应被跳过`,
      );
      assert.equal(report.notes?.length, 1);
    }
  });

  test("percent 为 0 是合法值", () => {
    const payload = specPayload() as { usage: Record<string, unknown> };
    payload.usage.rolling = { status: "ok", percent: 0 };

    const report = parseOpenCodeUsage(payload, 1);

    assert.equal(report.windows?.[0]?.percent, 0);
  });

  test("resetsAt 缺失或不可解析时省略该字段，但窗口保留", () => {
    const payload = specPayload() as { usage: Record<string, unknown> };
    payload.usage.rolling = { status: "ok", percent: 12, resetsAt: "not-a-date" };
    payload.usage.weekly = { status: "ok", percent: 34 };

    const report = parseOpenCodeUsage(payload, 1);

    assert.equal(report.windows?.length, 3);
    assert.equal(report.windows?.[0]?.resetsAt, undefined);
    assert.equal(report.windows?.[1]?.resetsAt, undefined);
    assert.ok(!("resetsAt" in (report.windows?.[0] ?? {})));
  });

  test("usage 缺失或非对象 → 抛错", () => {
    for (const payload of [{}, { usage: null }, { usage: "text" }, { usage: [] }, null, "body", 42]) {
      assert.throws(
        () => parseOpenCodeUsage(payload, 1),
        /usage/,
        `payload=${JSON.stringify(payload)} 应抛错`,
      );
    }
  });

  test("三窗口全部不可用 → 抛错", () => {
    assert.throws(
      () =>
        parseOpenCodeUsage(
          {
            usage: {
              rolling: { status: "exhausted", percent: 1 },
              weekly: { status: "ok", percent: -5 },
              monthly: { status: "ok" },
            },
          },
          1,
        ),
      /没有(任何)?可用窗口/,
    );
  });

  test("抛出错误的 message 不含原始响应体内容", () => {
    try {
      parseOpenCodeUsage(
        { usage: { rolling: { status: "exhausted", percent: 12, token: "leak-me-please" } } },
        1,
      );
      assert.fail("应当抛错");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes("leak-me-please"));
    }
  });
});

describe("fetchOpenCodeUsage", () => {
  test("成功路径：携带 Bearer key、拒绝重定向、交给解析", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((init) => {
      seenInit = init;
      return jsonResponse(specPayload());
    });

    const report = await fetchOpenCodeUsage(TEST_API_KEY, {
      fetchImpl: async (input, init) => {
        seenUrl = String(input);
        return fetchImpl(input, init);
      },
    });

    assert.equal(seenUrl, OPENCODE_USAGE_URL);
    assert.equal(new Headers(seenInit?.headers).get("Authorization"), `Bearer ${TEST_API_KEY}`);
    assert.equal(seenInit?.redirect, "error");
    assert.deepEqual(
      report.windows?.map((w) => w.percent),
      [12, 34, 56],
    );
    assert.equal(report.error, undefined);
  });

  test("401 → error.code 为 http-401，且不回显 key 或响应体", async () => {
    const fetchImpl = fakeFetch(() => new Response("denied-body-leak", { status: 401 }));

    const report = await fetchOpenCodeUsage(TEST_API_KEY, { fetchImpl });

    assert.equal(report.error?.code, "http-401");
    assert.equal(report.error?.message, "HTTP 401");
    assert.ok(!report.error.message.includes(TEST_API_KEY));
    assert.ok(!report.error.message.includes("denied-body-leak"));
    assert.equal(report.windows, undefined);
    assert.equal(report.kind, "windows");
    assert.equal(report.accountId, OPENCODE_ACCOUNT_ID);
  });

  test("500 等其他非 2xx 同样映射为 http-<status>", async () => {
    const report = await fetchOpenCodeUsage(TEST_API_KEY, {
      fetchImpl: fakeFetch(() => new Response("", { status: 500 })),
    });

    assert.equal(report.error?.code, "http-500");
  });

  test("fetch 抛错 → network", async () => {
    const report = await fetchOpenCodeUsage(TEST_API_KEY, {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    assert.equal(report.error?.code, "network");
    assert.equal(report.error?.message, "网络请求失败");
  });

  test("超时（timeoutMs 到期中止）→ timeout", async () => {
    const report = await fetchOpenCodeUsage(TEST_API_KEY, { fetchImpl: hangingFetch, timeoutMs: 30 });

    assert.equal(report.error?.code, "timeout");
  });

  test("外部 signal abort → timeout", async () => {
    const controller = new AbortController();
    const pending = fetchOpenCodeUsage(TEST_API_KEY, {
      fetchImpl: hangingFetch,
      signal: controller.signal,
      timeoutMs: 5000,
    });
    controller.abort();

    const report = await pending;

    assert.equal(report.error?.code, "timeout");
  });

  test("已 aborted 的 signal 立即失败为 timeout", async () => {
    const controller = new AbortController();
    controller.abort();

    const report = await fetchOpenCodeUsage(TEST_API_KEY, {
      fetchImpl: hangingFetch,
      signal: controller.signal,
    });

    assert.equal(report.error?.code, "timeout");
  });

  test("响应非合法 JSON → unknown-shape，不抛异常且不回显响应体", async () => {
    const report = await fetchOpenCodeUsage(TEST_API_KEY, {
      fetchImpl: fakeFetch(() => new Response("<html>not json</html>", { status: 200 })),
    });

    assert.equal(report.error?.code, "unknown-shape");
    assert.ok(!report.error.message.includes("not json"));
  });

  test("响应结构不可识别 → unknown-shape（不抛异常）", async () => {
    const report = await fetchOpenCodeUsage(TEST_API_KEY, {
      fetchImpl: fakeFetch(() => jsonResponse({ unexpected: true })),
    });

    assert.equal(report.error?.code, "unknown-shape");
    assert.equal(report.error?.message, "响应缺少 usage 对象");
  });

  test("空 key → missing-credential，且不发请求", async () => {
    let called = false;
    const opts: FetchOptions = {
      fetchImpl: async () => {
        called = true;
        return jsonResponse(specPayload());
      },
    };

    const report = await fetchOpenCodeUsage("", opts);

    assert.equal(report.error?.code, "missing-credential");
    assert.equal(called, false);
  });
});
