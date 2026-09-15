/**
 * src/footer.ts 单元测试（T3）。
 *
 * 全部断言基于固定的 now（t.mock.timers）与显式 resetsAt，不依赖真实当前时间。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDetail, renderFooter } from "../src/footer.js";
import type { AccountReport, QuotaWindow } from "../src/types.js";

/** 固定的「现在」，epoch 毫秒；与下面 resetsAt 的秒值精确对齐。 */
const FIXED_NOW_MS = 1_789_400_000_000;
const FIXED_NOW_SEC = FIXED_NOW_MS / 1000;

const HOUR = 3600;
const DAY = 86_400;

/** Ark-A：SPEC §2.3 实测样例的百分比，含重置时间。 */
function arkA(): AccountReport {
  return {
    accountId: "ark-a",
    displayName: "Ark-A",
    sourceId: "ark",
    kind: "windows",
    windows: [
      { level: "session", percent: 12.5, resetsAt: FIXED_NOW_SEC + 4 * HOUR + 12 * 60 },
      { level: "weekly", percent: 37.25, resetsAt: FIXED_NOW_SEC + 2 * DAY + 3 * HOUR },
      { level: "monthly", percent: 100, resetsAt: FIXED_NOW_SEC + 6 * DAY + 2 * HOUR },
    ],
    fetchedAt: FIXED_NOW_MS,
  };
}

/** Ark-B：SPEC §4.1 示例里的第二个账号。 */
function arkB(): AccountReport {
  return {
    accountId: "ark-b",
    displayName: "Ark-B",
    sourceId: "ark",
    kind: "windows",
    windows: [
      { level: "session", percent: 2, resetsAt: FIXED_NOW_SEC + 5 * HOUR + 30 * 60 },
      { level: "weekly", percent: 3 },
      { level: "monthly", percent: 15 },
    ],
    fetchedAt: FIXED_NOW_MS,
  };
}

/** DeepSeek：SPEC §2.2 实测样例。 */
function deepSeek(): AccountReport {
  return {
    accountId: "deepseek",
    displayName: "DeepSeek",
    sourceId: "deepseek",
    kind: "balance",
    balances: [{ currency: "CNY", total: "1234.56", granted: "0.00", toppedUp: "1234.56" }],
    fetchedAt: FIXED_NOW_MS,
  };
}

/** 失败段落；message 故意带标记串，用于验证它绝不会出现在输出里。 */
function errored(code: string): AccountReport {
  return {
    accountId: "ark-a",
    displayName: "Ark-A",
    sourceId: "ark",
    kind: "windows",
    fetchedAt: FIXED_NOW_MS,
    error: { code, message: "MARKER-must-not-appear-in-output" },
  };
}

test("renderFooter：空数组返回空字符串；renderDetail：空数组返回空列表", () => {
  assert.equal(renderFooter([]), "");
  assert.equal(renderFooter([], { maxWidth: 10, currentAccountId: "ark-a" }), "");
  assert.deepEqual(renderDetail([]), []);
});

test("renderFooter：单账号 windows 段形状（session→5h / weekly→wk / monthly→mo）", () => {
  assert.equal(renderFooter([arkA()]), "Ark-A 5h 13% wk 37% mo 100%");
});

test("renderFooter：多账号以 \" · \" 分隔", () => {
  const out = renderFooter([arkA(), arkB()]);
  assert.equal(out, "Ark-A 5h 13% wk 37% mo 100% · Ark-B 5h 21% wk 42% mo 63%");
  // 默认预算 60，此串 52 字符，不触发裁剪
  assert.ok(out.length < 60);
});

test("renderFooter：不渲染重置倒计时（裁剪级别 a 天然成立）", () => {
  const windowsWithoutReset: QuotaWindow[] = [
    { level: "session", percent: 12.5 },
    { level: "weekly", percent: 37.25 },
    { level: "monthly", percent: 100 },
  ];
  const withoutReset: AccountReport = { ...arkA(), windows: windowsWithoutReset };

  assert.equal(renderFooter([withoutReset]), renderFooter([arkA()]));
  assert.equal(renderFooter([arkA()]).includes("重置于"), false);
});

test("renderFooter：balance 段币种前缀 ¥ / $ / 其他代码", () => {
  assert.equal(renderFooter([deepSeek()]), "DeepSeek ¥1234.56");

  const usd: AccountReport = {
    ...deepSeek(),
    accountId: "zen",
    displayName: "Zen",
    sourceId: "opencode",
    balances: [{ currency: "USD", total: "12.34" }],
  };
  assert.equal(renderFooter([usd]), "Zen $12.34");

  const eur: AccountReport = { ...usd, balances: [{ currency: "EUR", total: "7.00" }] };
  assert.equal(renderFooter([eur]), "Zen EUR 7.00");

  const multi: AccountReport = {
    ...usd,
    balances: [
      { currency: "CNY", total: "1234.56" },
      { currency: "USD", total: "12.34" },
    ],
  };
  assert.equal(renderFooter([multi]), "Zen ¥1234.56 $12.34");
});

test("renderFooter：stale 段落加 \"~\" 前缀，其余段落不受影响", () => {
  assert.equal(renderFooter([{ ...arkB(), stale: true }]), "~Ark-B 5h 21% wk 42% mo 63%");
  assert.equal(
    renderFooter([arkA(), { ...arkB(), stale: true }]),
    "Ark-A 5h 13% wk 37% mo 100% · ~Ark-B 5h 21% wk 42% mo 63%",
  );
});

test("renderFooter：error 段落渲染为 \"<displayName> ✗ <短原因>\"，且不影响其他段落", () => {
  const expected: Record<string, string> = {
    "missing-credential": "未配置",
    NotLogin: "cookie 过期",
    InvalidCSRFToken: "cookie 不完整",
    "unknown-shape": "接口变更",
    network: "网络错误",
    timeout: "超时",
  };
  for (const [code, text] of Object.entries(expected)) {
    assert.equal(
      renderFooter([errored(code), arkB()]),
      `Ark-A ✗ ${text} · Ark-B 5h 21% wk 42% mo 63%`,
    );
  }

  assert.equal(renderFooter([errored("http-401")]), "Ark-A ✗ HTTP 401");
});

test("renderFooter：未登记的 error code 原样展示，绝不回显 message", () => {
  const out = renderFooter([errored("weird-code")]);
  assert.equal(out, "Ark-A ✗ weird-code");
  assert.equal(out.includes("MARKER"), false);
});

test("renderFooter：maxWidth 裁剪优先保住全部账号（D-09），实在不够才砍账号", () => {
  // 30 预算：compact 全量（28 字符）装得下 → 两个账号都保住
  assert.equal(
    renderFooter([arkA(), arkB()], { maxWidth: 30, currentAccountId: "ark-a" }),
    "Ark-A mo 100% · Ark-B mo 63%",
  );
  assert.equal(
    renderFooter([arkA(), arkB()], { maxWidth: 30, currentAccountId: "ark-b" }),
    "Ark-A mo 100% · Ark-B mo 63%",
  );
  // 26 预算：compact 全量（28）装不下 → 退到只留当前账号的完整形态
  assert.equal(
    renderFooter([arkA(), arkB()], { maxWidth: 26, currentAccountId: "ark-a" }),
    "Ark-A 5h 13% wk 37% mo 100%",
  );
  assert.equal(
    renderFooter([arkA(), arkB()], { maxWidth: 26, currentAccountId: "ark-b" }),
    "Ark-B 5h 21% wk 42% mo 63%",
  );
});

test("renderFooter：当前账号段仍超宽则退化为最简形态（级别 c）", () => {
  // 25 字符的完整段在 26 预算下保留，在 24 预算下退化为 "Ark-A mo 100%"
  assert.equal(
    renderFooter([arkA(), arkB()], { maxWidth: 26, currentAccountId: "ark-a" }),
    "Ark-A 5h 13% wk 37% mo 100%",
  );
  assert.equal(
    renderFooter([arkA(), arkB()], { maxWidth: 24, currentAccountId: "ark-a" }),
    "Ark-A mo 100%",
  );
  // balance 段本身即最简形态，超宽时直接进入截断
  assert.equal(renderFooter([deepSeek()], { maxWidth: 5, currentAccountId: "deepseek" }), "Deep…");
});

test("renderFooter：仍超宽则截断并加 \"…\"（级别 d）", () => {
  assert.equal(renderFooter([arkA(), arkB()], { maxWidth: 8, currentAccountId: "ark-a" }), "Ark-A m…");
  // 无 currentAccountId / 不匹配任何账号 → 先逐段 compact（保留最有价值的 monthly），
  // 仍超宽才截断。
  assert.equal(renderFooter([arkA(), arkB()], { maxWidth: 10 }), "Ark-A mo …");
  assert.equal(
    renderFooter([arkA(), arkB()], { maxWidth: 10, currentAccountId: "zen" }),
    "Ark-A mo …",
  );
  // 极端预算：只剩截断标记
  assert.equal(renderFooter([arkA(), arkB()], { maxWidth: 1 }), "…");
});

test("renderDetail：windows 段逐行输出百分比与重置倒计时", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW_MS });
  assert.deepEqual(renderDetail([arkA()]), [
    "Ark-A (ark)",
    "  session  已用 12.5%  重置于 4h 12m 后",
    "  weekly  已用 37.3%  重置于 2d 3h 后",
    "  monthly  已用 100.0%  重置于 6d 2h 后",
  ]);
});

test("renderDetail：无重置信息不渲染倒计时；小于 1 分钟显示 <1m", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW_MS });
  const report: AccountReport = {
    accountId: "opencode",
    displayName: "Zen",
    sourceId: "opencode",
    kind: "windows",
    windows: [
      { level: "session", percent: 12, resetsAt: FIXED_NOW_SEC + 30 },
      { level: "weekly", percent: 34, resetsAt: FIXED_NOW_SEC - 60 },
      { level: "monthly", percent: 56 },
    ],
    fetchedAt: FIXED_NOW_MS,
  };
  assert.deepEqual(renderDetail([report]), [
    "Zen (opencode)",
    "  session  已用 12.0%  重置于 <1m 后",
    "  weekly  已用 34.0%  重置于 <1m 后",
    "  monthly  已用 56.0%",
  ]);
});

test("renderDetail：balance 段每币种一行，缺失字段省略", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW_MS });
  const minimal: AccountReport = {
    accountId: "opencode",
    displayName: "Zen",
    sourceId: "opencode",
    kind: "balance",
    balances: [{ currency: "USD", total: "12.34" }],
    fetchedAt: FIXED_NOW_MS,
  };
  assert.deepEqual(renderDetail([deepSeek(), minimal]), [
    "DeepSeek (deepseek)",
    "  CNY  总额 1234.56  赠送 0.00  充值 1234.56",
    "Zen (opencode)",
    "  USD  总额 12.34",
  ]);
});

test("renderDetail：error 段展示错误码与短原因；stale 段标注上次成功数据", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW_MS });
  assert.deepEqual(renderDetail([errored("NotLogin")]), ["Ark-A (ark)", "  ✗ NotLogin · cookie 过期"]);
  assert.deepEqual(renderDetail([{ ...arkB(), stale: true }]), [
    "Ark-B (ark) （上次成功数据）",
    "  session  已用 21.0%  重置于 5h 30m 后",
    "  weekly  已用 42.0%",
    "  monthly  已用 63.0%",
  ]);
});

test("renderDetail：多账号按传入顺序依次成段", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW_MS });
  const lines = renderDetail([arkB(), arkA()]);
  assert.equal(lines[0], "Ark-B (ark)");
  assert.equal(lines[4], "Ark-A (ark)");
  assert.equal(lines.length, 8);
});
