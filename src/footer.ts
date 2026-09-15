/**
 * footer 单行渲染 / 详情渲染 + 宽度预算裁剪（纯函数，无 IO）。
 * 契约见 tasks/TEAM-SYNC.md §1.2；错误短原因映射见 §1.3。
 * 未登记的 error code 只展示 code 本身，绝不回显 QuotaError.message。
 */

import type { AccountReport, WindowLevel } from "./types.js";

export interface FooterOptions {
  /** 可见字符上限（按 Unicode 码点计），默认 60。 */
  maxWidth?: number;
  /** 当前活跃账号 id（多账号时用于裁剪优先级）。 */
  currentAccountId?: string;
}

/** 默认宽度预算（SPEC §4.1）/ 账号段落分隔符 / 截断收尾标记。 */
const DEFAULT_MAX_WIDTH = 60;
const SEGMENT_SEPARATOR = " · ";
const ELLIPSIS = "…";

/** footer 的窗口标签：session→5h、weekly→wk、monthly→mo。 */
const WINDOW_LABELS: Record<WindowLevel, string> = {
  session: "5h",
  weekly: "wk",
  monthly: "mo",
};

/** 窗口渲染顺序固定为 5h / wk / mo，与 SPEC §4.1 的示例一致。 */
const WINDOW_ORDER: readonly WindowLevel[] = ["session", "weekly", "monthly"];

/** §1.3 错误码 → 可展示短句。 */
const ERROR_TEXTS: Record<string, string> = {
  "missing-credential": "未配置",
  NotLogin: "cookie 过期",
  InvalidCSRFToken: "cookie 不完整",
  "unknown-shape": "接口变更",
  network: "网络错误",
  timeout: "超时",
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** footer 的百分比取整（SPEC 示例：6.57 → 7，100 → 100）。 */
function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

/** §1.3 映射：已知 code 用展示文本，`http-<status>` 用 `HTTP <status>`，其余原样返回 code。 */
function errorReason(code: string): string {
  if (code.startsWith("http-")) {
    const status = code.slice("http-".length);
    return status.length > 0 ? `HTTP ${status}` : code;
  }
  return ERROR_TEXTS[code] ?? code;
}

/** 币种前缀：CNY→¥、USD→$、其余用「代码 + 空格」。 */
function currencyPrefix(currency: string): string {
  if (currency === "CNY") return "¥";
  if (currency === "USD") return "$";
  return `${currency} `;
}

/** 可见宽度：按 Unicode 码点计，避免 UTF-16 代理对造成偏差。 */
function visibleWidth(text: string): number {
  return Array.from(text).length;
}

function truncateToWidth(text: string, maxWidth: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxWidth) return text;
  return `${chars.slice(0, Math.max(maxWidth - 1, 0)).join("")}${ELLIPSIS}`;
}

/** 段落主体：windows 类为各窗口百分比，balance 类为各币种金额。 */
function segmentBody(report: AccountReport): string[] {
  if (report.kind === "balance") {
    return (report.balances ?? []).map((entry) => `${currencyPrefix(entry.currency)}${entry.total}`);
  }
  const parts: string[] = [];
  for (const level of WINDOW_ORDER) {
    const window = (report.windows ?? []).find((candidate) => candidate.level === level);
    if (window === undefined) continue;
    parts.push(`${WINDOW_LABELS[level]} ${formatPercent(window.percent)}`);
  }
  return parts;
}

/** 段落名的 stale 前缀。 */
function segmentName(report: AccountReport): string {
  return report.stale === true ? `~${report.displayName}` : report.displayName;
}

/**
 * 完整形态段落。刻意不含重置时间（resetsAt）—— 倒计时只由 renderDetail 渲染，
 * 因此宽度裁剪的第一级（先砍倒计时）在 footer 里天然成立，无字段可砍。
 */
function renderSegment(report: AccountReport): string {
  if (report.error !== undefined) {
    return `${report.displayName} ✗ ${errorReason(report.error.code)}`;
  }
  const body = segmentBody(report);
  if (body.length === 0) return segmentName(report);
  return `${segmentName(report)} ${body.join(" ")}`;
}

/** 最简形态段落（裁剪第三级）：只有 windows 段还能再退化，错误段与余额段本身已是最短。 */
function renderCompactSegment(report: AccountReport): string {
  if (report.error !== undefined || report.kind === "balance") return renderSegment(report);
  const windows = report.windows ?? [];
  const window =
    windows.find((candidate) => candidate.level === "monthly") ?? windows[windows.length - 1];
  if (window === undefined) return segmentName(report);
  return `${segmentName(report)} ${WINDOW_LABELS[window.level]} ${formatPercent(window.percent)}`;
}

/** 单行 footer 文本。空数组 → 返回 ""。 */
export function renderFooter(reports: AccountReport[], opts: FooterOptions = {}): string {
  if (reports.length === 0) return "";
  const maxWidth = opts.maxWidth ?? DEFAULT_MAX_WIDTH;
  if (maxWidth <= 0) return "";

  const full = reports.map(renderSegment).join(SEGMENT_SEPARATOR);
  if (visibleWidth(full) <= maxWidth) return full;

  // 裁剪顺序（SPEC §4.1，先砍低优先级）：(a) 砍重置倒计时 —— footer 段落不含该字段，天然满足；
  // (b) 砍非当前账号；(c) 当前账号退化为最简形态；(d) 仍超宽 → 截断并加 "…"。
  const currentAccountId = opts.currentAccountId;
  const currentReports =
    currentAccountId === undefined
      ? []
      : reports.filter((report) => report.accountId === currentAccountId);

  if (currentReports.length > 0) {
    const trimmed = currentReports.map(renderSegment).join(SEGMENT_SEPARATOR);
    if (visibleWidth(trimmed) <= maxWidth) return trimmed;
    const compact = currentReports.map(renderCompactSegment).join(SEGMENT_SEPARATOR);
    if (visibleWidth(compact) <= maxWidth) return compact;
    return truncateToWidth(compact, maxWidth);
  }

  return truncateToWidth(full, maxWidth);
}

/** 重置倒计时：<1 分钟 → "<1m"；<1 天 → "4h 12m"；否则 "2d 3h"。 */
function formatCountdown(resetsAtSec: number, nowMs: number): string {
  const remainingMs = resetsAtSec * 1000 - nowMs;
  if (remainingMs < MINUTE_MS) return "<1m";
  if (remainingMs >= DAY_MS) {
    const days = Math.floor(remainingMs / DAY_MS);
    const hours = Math.floor((remainingMs % DAY_MS) / HOUR_MS);
    return `${days}d ${hours}h`;
  }
  const hours = Math.floor(remainingMs / HOUR_MS);
  const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS);
  return `${hours}h ${minutes}m`;
}

function detailLines(report: AccountReport, nowMs: number): string[] {
  const staleSuffix = report.stale === true ? "（上次成功数据）" : "";
  const lines = [`${report.displayName} (${report.sourceId}) ${staleSuffix}`.trimEnd()];

  if (report.error !== undefined) {
    lines.push(`  ✗ ${report.error.code} · ${errorReason(report.error.code)}`);
    return lines;
  }

  if (report.kind === "balance") {
    for (const entry of report.balances ?? []) {
      const parts = [`总额 ${entry.total}`];
      if (entry.granted !== undefined) parts.push(`赠送 ${entry.granted}`);
      if (entry.toppedUp !== undefined) parts.push(`充值 ${entry.toppedUp}`);
      lines.push(`  ${entry.currency}  ${parts.join("  ")}`);
    }
    return lines;
  }

  const windows = report.windows ?? [];
  for (const level of WINDOW_ORDER) {
    const window = windows.find((candidate) => candidate.level === level);
    if (window === undefined) continue;
    let line = `  ${level}  已用 ${window.percent.toFixed(1)}%`;
    if (window.resetsAt !== undefined) {
      line += `  重置于 ${formatCountdown(window.resetsAt, nowMs)} 后`;
    }
    lines.push(line);
  }
  return lines;
}

/** /quota 详情视图：逐行文本，含重置倒计时。空数组 → 返回 []。 */
export function renderDetail(reports: AccountReport[]): string[] {
  const nowMs = Date.now();
  const lines: string[] = [];
  for (const report of reports) {
    lines.push(...detailLines(report, nowMs));
  }
  return lines;
}
