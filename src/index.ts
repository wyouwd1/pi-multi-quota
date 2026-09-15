/**
 * pi-multi-quota 扩展入口。
 *
 * 职责：
 * - 订阅 session_start / model_select / session_shutdown，维护 footer 状态
 * - 注册 /quota 命令族（详情 · 全量 · 配置 cookie · 列出账号）
 *
 * 硬性约束（SPEC.md §4.1 刷新时机 · §12 Never）：
 * - 定时器**只在 session_start 启动**、session_shutdown 清理（factory 可能在无会话的调用中运行）
 * - 任何输出路径都不得包含 cookie 原文
 * - 额度数据不写入 session、不发送给模型
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AccountReport, SourceId } from "./types.js";
import {
  findArkAccountById,
  findArkAccountByProvider,
  loadConfig,
  redact,
  saveConfig,
  upsertArkAccount,
  type QuotaConfig,
} from "./config.js";
import { describeExpiry, parseArkCookie } from "./cookie.js";
import {
  createCache,
  dedupe,
  getFresh,
  getLastKnown,
  noteFailure,
  noteSuccess,
  put,
  shouldQuery,
  type QuotaCache,
} from "./cache.js";
import { renderDetail, renderFooter } from "./footer.js";
import { sourceForBaseUrl, sourceLabel, targetsForSource } from "./registry.js";
import { fetchArkUsage } from "./sources/ark.js";

const STATUS_KEY = "multi-quota";
const WIDGET_KEY = "multi-quota-detail";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** cookie 剩余寿命低于此值时在 footer 挂提醒。 */
const EXPIRY_WARN_MS = 2 * 60 * 60 * 1000;

export default function (pi: ExtensionAPI): void {
  const cache: QuotaCache = createCache();
  let timer: ReturnType<typeof setInterval> | undefined;
  let reports: AccountReport[] = [];
  let currentAccountId: string | undefined;
  let warnedExpiry = false;

  // ---------------------------------------------------------------- 工具

  /** 读取配置；损坏时返回空配置并提示，绝不让扩展整体崩掉。 */
  function safeConfig(ctx: ExtensionContext): QuotaConfig | undefined {
    try {
      return loadConfig();
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      ctx.ui.notify(`多额度：配置文件读取失败 —— ${message}`, "error");
      return undefined;
    }
  }

  /** 当前 provider 对应的 Ark 账号 id（多账号时决定 footer 裁剪优先级）。 */
  function resolveCurrentAccountId(config: QuotaConfig, providerId: string | undefined): string | undefined {
    if (!providerId) return undefined;
    return findArkAccountByProvider(config, providerId)?.id;
  }

  function publish(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const text = renderFooter(reports, { currentAccountId });
    ctx.ui.setStatus(STATUS_KEY, text.length > 0 ? text : undefined);
  }

  function clear(ctx: ExtensionContext): void {
    reports = [];
    currentSource = undefined;
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  }

  let currentSource: SourceId | undefined;

  // ------------------------------------------------------------ 核心刷新

  /**
   * 刷新当前数据源的全部账号。
   * - 命中新鲜缓存 → 直接用，不打网络
   * - 处于退避窗口 → 用上次已知数据（保留 stale 语义）
   * - 否则查询；失败时保留上次数据并标记 stale
   */
  async function refresh(ctx: ExtensionContext, force: boolean): Promise<AccountReport[]> {
    const model = ctx.model;
    const source = sourceForBaseUrl(model?.baseUrl);

    if (!model || !source) {
      clear(ctx);
      return [];
    }

    const config = safeConfig(ctx);
    if (!config) {
      clear(ctx);
      return [];
    }

    currentSource = source;
    currentAccountId = resolveCurrentAccountId(config, model.provider);

    const targets = targetsForSource(source, model.provider, {
      auth: { getProviderAuth: (providerId) => ctx.modelRegistry.getProviderAuth(providerId) },
      config,
    });

    if (targets.length === 0) {
      clear(ctx);
      return [];
    }

    const settled = await Promise.all(
      targets.map(async (target): Promise<AccountReport> => {
        const fresh = getFresh(cache, target.accountId);
        if (fresh && !force) return fresh;

        if (!force && !shouldQuery(cache, target.accountId)) {
          const lastKnown = getLastKnown(cache, target.accountId);
          if (lastKnown) return { ...lastKnown, stale: true };
        }

        try {
          const report = await dedupe(cache, target.accountId, () => target.query());
          if (report.error) {
            noteFailure(cache, target.accountId);
            const lastKnown = getLastKnown(cache, target.accountId);
            return lastKnown ? { ...report, stale: true } : report;
          }
          noteSuccess(cache, target.accountId);
          put(cache, report);
          return report;
        } catch (err) {
          noteFailure(cache, target.accountId);
          // 外部 pi API 的异常文本不在本项目控制内，统一脱敏后再入报告
          const message = redact(err instanceof Error ? err.message : "查询失败");
          const lastKnown = getLastKnown(cache, target.accountId);
          return {
            accountId: target.accountId,
            displayName: target.displayName,
            sourceId: target.sourceId,
            kind: source === "deepseek" ? "balance" : "windows",
            fetchedAt: Date.now(),
            error: { code: "unknown-shape", message },
            ...(lastKnown ? { stale: true, windows: lastKnown.windows, balances: lastKnown.balances } : {}),
          };
        }
      }),
    );

    reports = settled;
    publish(ctx);
    return settled;
  }

  /** 检查 Ark cookie 剩余寿命，必要时提醒一次。 */
  function checkExpiry(ctx: ExtensionContext, config: QuotaConfig): void {
    if (!ctx.hasUI) return;
    const soon: string[] = [];
    for (const account of config.ark.accounts) {
      const parsed = parseArkCookie(account.cookie);
      if (!parsed.ok) continue;
      const remaining = parsed.value.expiresInMs;
      if (remaining === undefined) continue;
      if (remaining < EXPIRY_WARN_MS) {
        soon.push(`${account.id}（${describeExpiry(remaining)}）`);
      }
    }
    if (soon.length > 0 && !warnedExpiry) {
      warnedExpiry = true;
      ctx.ui.notify(
        `多额度：Ark cookie 即将失效 —— ${soon.join("、")}。用 /quota set <账号> 更新。`,
        "warning",
      );
    }
  }

  // ---------------------------------------------------------------- 定时器

  function stopTimer(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function startTimer(ctx: ExtensionContext): void {
    stopTimer();
    timer = setInterval(() => {
      void refresh(ctx, false);
    }, REFRESH_INTERVAL_MS);
    // 不阻止进程退出
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
  }

  // ---------------------------------------------------------------- 事件

  pi.on("session_start", async (_event, ctx) => {
    warnedExpiry = false;
    const config = safeConfig(ctx);
    await refresh(ctx, false);
    if (config) checkExpiry(ctx, config);
    startTimer(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    // 换了模型 → 可能换了数据源，强制刷新一次
    await refresh(ctx, true);
  });

  pi.on("session_shutdown", () => {
    stopTimer();
  });

  // ---------------------------------------------------------------- 命令

  /** 查询指定数据源（供详情命令复用）。 */
  async function collect(ctx: ExtensionCommandContext, source: SourceId): Promise<AccountReport[]> {
    const config = safeConfig(ctx);
    if (!config) return [];
    const providerId = ctx.model?.provider;
    if (!providerId) return [];

    const targets = targetsForSource(source, providerId, {
      auth: { getProviderAuth: (p) => ctx.modelRegistry.getProviderAuth(p) },
      config,
    });

    const settled = await Promise.all(
      targets.map(async (target): Promise<AccountReport> => {
        try {
          const report = await dedupe(cache, target.accountId, () => target.query());
          if (!report.error) {
            noteSuccess(cache, target.accountId);
            put(cache, report);
          } else {
            noteFailure(cache, target.accountId);
          }
          return report;
        } catch (err) {
          noteFailure(cache, target.accountId);
          const message = redact(err instanceof Error ? err.message : "查询失败");
          return {
            accountId: target.accountId,
            displayName: target.displayName,
            sourceId: target.sourceId,
            kind: "windows",
            fetchedAt: Date.now(),
            error: { code: "unknown-shape", message },
          };
        }
      }),
    );
    return settled;
  }

  function show(ctx: ExtensionCommandContext, title: string, lines: string[]): void {
    if (!ctx.hasUI) {
      // 非 TUI：退化为 notify，避免静默无输出
      ctx.ui.notify([title, ...lines].join("\n"), "info");
      return;
    }
    ctx.ui.setWidget(WIDGET_KEY, [title, ...lines, "", "（/quota close 关闭此面板）"]);
  }

  pi.registerCommand("quota", {
    description: "查看当前供应商额度明细（all=查全部 · set <账号>=更新 cookie · list=账号与有效期 · close=关闭面板）",
    getArgumentCompletions: (prefix: string) => {
      const options = ["all", "set", "list", "close"];
      const hits = options.filter((o) => o.startsWith(prefix));
      return hits.length > 0 ? hits.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();
      const [head, ...rest] = input.split(/\s+/);

      if (head === "close") {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        return;
      }

      if (head === "list") {
        const config = safeConfig(ctx);
        if (!config) return;
        if (config.ark.accounts.length === 0) {
          show(ctx, "已配置账号：无", [
            "先在 ~/.pi/agent/multi-quota.json 里创建账号槽位（含 provider 字段）",
            "再用 /quota set ark-a 粘贴这个账号的控制台 cookie",
          ]);
          return;
        }
        const lines = config.ark.accounts.map((account) => {
          const parsed = parseArkCookie(account.cookie);
          const life = parsed.ok
            ? parsed.value.expiresInMs !== undefined
              ? describeExpiry(parsed.value.expiresInMs)
              : "无过期信息"
            : `解析失败（${parsed.code}）`;
          return `  ${account.id}  provider=${account.provider}  cookie ${life}`;
        });
        show(ctx, "已配置账号：", lines);
        return;
      }

      if (head === "set") {
        const accountId = rest[0];
        const config = safeConfig(ctx);
        if (!config) return;
        if (!accountId) {
          show(ctx, "用法：/quota set <账号 id>", [
            "例如 /quota set ark-a",
            `当前已配置：${config.ark.accounts.map((a) => a.id).join("、") || "（无）"}`,
          ]);
          return;
        }

        const slot = findArkAccountById(config, accountId);
        if (!slot) {
          show(ctx, `未找到账号 ${accountId}`, [
            `当前已配置：${config.ark.accounts.map((a) => a.id).join("、") || "（无）"}`,
            "提示：先在 ~/.pi/agent/multi-quota.json 里创建该账号槽位（含 provider 字段）",
          ]);
          return;
        }

        const pasted = await ctx.ui.input(`粘贴 ${accountId} 的控制台 cookie：`, "整段 cookie，不是单个值");
        if (pasted === undefined || pasted.trim().length === 0) {
          ctx.ui.notify("已取消，未做任何修改。", "info");
          return;
        }

        const parsed = parseArkCookie(pasted.trim());
        if (!parsed.ok) {
          const hint =
            parsed.code === "missing-csrf"
              ? "cookie 不完整，请复制整段 cookie（含 csrfToken）"
              : parsed.code === "missing-digest"
                ? "cookie 不完整，请确认已登录控制台后复制整段 cookie"
                : "digest 无法解析，请重新登录控制台后复制整段 cookie";
          ctx.ui.notify(`校验失败：${hint}`, "error");
          return;
        }

        // 账号防呆：新 cookie 的 AccountID 不能与其它槽位指向同一个火山账号
        const incomingAccount = parsed.value.accountId;
        if (incomingAccount !== undefined) {
          const clash = config.ark.accounts.find((other) => {
            if (other.id === accountId) return false;
            const otherParsed = parseArkCookie(other.cookie);
            return otherParsed.ok && otherParsed.value.accountId === incomingAccount;
          });
          if (clash) {
            ctx.ui.notify(
              `拒绝保存：该 cookie 属于账号 ${incomingAccount}，与 ${clash.id} 是同一个火山账号。请确认是否登错了账号。`,
              "error",
            );
            return;
          }
        }

        // 当场发真实请求校验
        const candidate = { ...slot, cookie: pasted.trim() };
        const result = await fetchArkUsage(candidate);
        if (result.error) {
          ctx.ui.notify(
            `校验失败（${result.error.code}）：${result.error.message}。未保存。`,
            "error",
          );
          return;
        }

        const next = upsertArkAccount(config, candidate);
        try {
          saveConfig(next);
        } catch (err) {
          const message = redact(err instanceof Error ? err.message : String(err));
          ctx.ui.notify(`保存失败：${message}`, "error");
          return;
        }

        warnedExpiry = false;
        const summary = (result.windows ?? [])
          .map((w) => `${w.level} ${w.percent.toFixed(1)}%`)
          .join(" · ");
        ctx.ui.notify(`${accountId} 已更新${summary.length > 0 ? `：${summary}` : ""}`, "info");
        await refresh(ctx, true);
        return;
      }

      if (head === "all") {
        const sources: SourceId[] = ["ark", "opencode", "deepseek"];
        const groups = await Promise.all(
          sources.map(async (source) => ({ source, list: await collect(ctx, source) })),
        );
        const lines: string[] = [];
        for (const group of groups) {
          lines.push(`【${sourceLabel(group.source)}】`);
          if (group.list.length === 0) {
            lines.push("  （当前 provider 不匹配此数据源）");
          } else {
            lines.push(...renderDetail(group.list));
          }
          lines.push("");
        }
        show(ctx, "全部供应商额度", lines);
        return;
      }

      // 默认：当前数据源
      const source = currentSource ?? sourceForBaseUrl(ctx.model?.baseUrl);
      if (!source) {
        show(ctx, "当前模型不属于已支持的供应商", [
          "支持：火山方舟 Ark · OpenCode Go · DeepSeek",
          "用 /quota all 查看全部（需切换到对应 provider）",
        ]);
        return;
      }
      const list = await collect(ctx, source);
      show(ctx, `${sourceLabel(source)} 额度明细`, renderDetail(list));
    },
  });
}
