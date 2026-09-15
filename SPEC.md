# SPEC: pi-multi-quota

> 状态：待 review
> 产出日期：2026-09-15
> 前置：本 spec 由访谈（8 轮问答）收敛而来，所有决策均已由本人逐条确认。

---

## 1. Objective

一个**本地自用**的 pi package，用**纯 HTTP、零子进程**在 footer 实时显示「当前模型所属供应商」的额度，并提供 `/quota` 命令做主动查询与全量对比。

### 为什么做

现有生态包三条路都堵：

| 现有包 | 阻塞点 |
|---|---|
| `@imdlan/pi-usage` | 不支持 Ark（火山引擎） |
| `@narumitw/pi-usage` | 精确匹配 `providerId === "opencode-go"`，本机 id 是 `opencode-go-ds` |
| `pi-ark-quota` / `pi-cloud-quota` | 支持 Ark，但依赖 `arkcli` + 火山 SSO 登录 |

而本机有**两个不同的火山账号**，额度完全不透明 —— 访谈中实测才发现其中一个账号的月度额度已接近上限。

### 成功的样子

1. 使用任一 Ark provider 时，footer 并排显示 **Ark-A / Ark-B 两个账号**的 5h / 周 / 月百分比
2. 切到 OpenCode 或 DeepSeek，footer **整段自动替换**为对应供应商
3. `/quota` 展开当前供应商明细；`/quota all` 一次查全部（4 个请求并发）
4. cookie 将过期有提醒；过期后明确指示 `/quota set ark-a`
5. 全程不依赖任何 CLI、不需要 SSO

### 最终用户

仅本人。不发布 npm。

---

## 2. 已实测的技术事实（不可推翻的设计前提）

以下全部在 2026-09-15 实测确认，非推测。

### 2.1 OpenCode Go

- 端点：`GET https://opencode.ai/zen/go/v1/usage`
- 鉴权：`Authorization: Bearer <apiKey>`（key 已在 pi 的 models.json 中）
- 实测：HTTP 200
- 响应：

```json
{"usage":{
  "rolling":{"status":"ok","percent":12,"resetsAt":"2027-01-15T09:12:05.000Z"},
  "weekly":{"status":"ok","percent":34,"resetsAt":"2027-01-21T00:00:00.000Z"},
  "monthly":{"status":"ok","percent":56,"resetsAt":"2027-01-18T11:45:30.000Z"}}}
```

- `status` 可能为 `"ok"` / `"rate-limited"`，其余值视为不可用并降级为 note

### 2.2 DeepSeek

- 端点：`GET https://api.deepseek.com/user/balance`
- 鉴权：`Authorization: Bearer <apiKey>`（key 在 pi 的 auth.json 中）
- 实测：HTTP 200
- 响应：

```json
{"is_available":true,
 "balance_infos":[{"currency":"CNY","total_balance":"1234.56",
                   "granted_balance":"0.00","topped_up_balance":"1234.56"}]}
```

- 金额是**字符串**，需保持精确，不得转 float 后再显示
- 多币种（CNY / USD）分别显示，**不相加、不换算**

### 2.3 Ark（火山引擎 Coding Plan）

- 端点：`POST https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage?`
- **最小必需凭据集合**（10 次对照实验得出）：

| 要素 | 必需 | 说明 |
|---|---|---|
| 完整 cookie 串（含 `digest`） | ✅ | 约 3.5 KB |
| `x-csrf-token` header | ✅ | 缺失返回 `InvalidCSRFToken` |
| `x-web-id` | ❌ | 实测不需要 |
| `origin` / `referer` | ❌ | 实测不需要 |
| `User-Agent` | ❌ | 实测不需要 |

- **关键简化**：`x-csrf-token` 的值与 cookie 中 `csrfToken=` 完全相同 ⇒ 程序自行解析，**用户只需维护一个 cookie 字符串**
- 请求体：`{}`，`Content-Type: application/json`
- 实测成功响应：

```json
{"ResponseMetadata":{...},"Result":{
  "Status":"Running","UpdateTimestamp":1899990000,
  "QuotaUsage":[
    {"Level":"session","Percent":12.5,"ResetTimestamp":1900000000,"Cap":100,"RewardTotalPercent":0},
    {"Level":"weekly","Percent":37.25,"ResetTimestamp":1900100000,"Cap":100,"RewardTotalPercent":0},
    {"Level":"monthly","Percent":100,"ResetTimestamp":1900200000,"Cap":100,"RewardTotalPercent":0}],
  "HasReward":false}}
```

- 失败响应形态（**HTTP 200 但 body 带 Error**，必须解析 body 而不仅是状态码）：

```json
{"ResponseMetadata":{"Error":{"Code":"NotLogin","Message":"Not logged in"}}}
{"ResponseMetadata":{"Error":{"Code":"InvalidCSRFToken","Message":"Invalid CSRF token."}}}
```

- **额度是账号级**，不是 key 级
- **唯一硬约束**：`digest` 是 SSO access token，`exp` 约 **24 小时**，必须人工更新

---

## 3. 架构

### 3.1 供应商映射（按 baseUrl host，不按 provider id）

采用 **host 匹配**而非 provider id 精确匹配，理由：本机 provider id 是自定义的（`opencode-go-ds`），且未来可能改名。

| baseUrl host | source | 账号数 |
|---|---|---|
| `ark.cn-beijing.volces.com` | `ark` | 2（由配置决定） |
| `opencode.ai` | `opencode` | 1 |
| `api.deepseek.com` | `deepseek` | 1 |

Ark 的多账号通过在配置中**按 provider id 绑定 cookie** 来区分。

### 3.2 数据模型

```ts
type WindowLevel = "session" | "weekly" | "monthly";

type QuotaWindow = {
  level: WindowLevel;
  percent: number;        // 0-100，已用百分比
  resetsAt?: number;      // epoch 秒
};

type BalanceEntry = {
  currency: string;       // "CNY" | "USD"
  total: string;          // 精确保留字符串
  granted?: string;
  toppedUp?: string;
};

type AccountReport = {
  accountId: string;      // "ark-a" | "ark-b" | "opencode" | "deepseek"
  displayName: string;    // "Ark-A"
  sourceId: "ark" | "opencode" | "deepseek";
  kind: "windows" | "balance";
  windows?: QuotaWindow[];
  balances?: BalanceEntry[];
  fetchedAt: number;
  error?: { code: string; message: string };
  stale?: boolean;        // 显示的是上次成功的数据
  notes?: string[];
};
```

### 3.3 模块划分

| 模块 | 职责 | 依赖 |
|---|---|---|
| `types.ts` | 上述类型定义 | — |
| `cookie.ts` | 解析 cookie：提取 `csrfToken`、解码 `digest` 的 `exp` | — |
| `config.ts` | 读写配置、chmod 600、cookie 脱敏 | types |
| `sources/ark.ts` | Ark 适配器（多账号，POST + csrf） | cookie, config |
| `sources/opencode.ts` | OpenCode Go 适配器 | — |
| `sources/deepseek.ts` | DeepSeek 适配器 | — |
| `registry.ts` | host → source 分派 + 凭据解析 | sources |
| `cache.ts` | 5 分钟缓存、stale 标记、并发去重 | types |
| `footer.ts` | footer 文本渲染 + 宽度预算裁剪 | types |
| `index.ts` | 扩展入口：事件订阅、命令注册、UI 交互 | 全部 |

---

## 4. 交互设计

### 4.1 footer（无感跟随）

**逻辑**：读取 `ctx.model` → 按 baseUrl host 判定 source → 渲染该 source 下**全部账号**。

```
# 当前模型是 volcengine 或 volcengine-2（Ark）
Ark-A 5h 13% wk 37% mo 100% · Ark-B 5h 21% wk 42% mo 63%

# 当前模型是 opencode-go-ds
Zen 5h 12% wk 34% mo 56%

# 当前模型是 deepseek
DeepSeek ¥1234.56
```

**宽度预算**：默认上限 60 可见字符，超出按序裁剪：
1. 先砍重置倒计时
2. 再砍非当前账号
3. 单段最短形态：`Ark-A mo 100%`

**刷新时机**：
- `session_start`：立即刷新
- `model_select`：立即刷新（source 变化时）
- 定时器：5 分钟一次，**仅刷新当前 source**
- 不使用扩展时（`ctx.hasUI === false`）不发布 footer，但缓存仍然可用

### 4.2 命令

| 命令 | 行为 |
|---|---|
| `/quota` | 展开当前供应商明细：每账号的窗口百分比 + 重置倒计时；balance 类显示余额明细与状态 |
| `/quota all` | 并发查询全部（Ark 两账号 + Zen + DeepSeek，共 4 请求），并排展示 |
| `/quota set <account>` | 打开多行编辑器粘贴 cookie → **当场发真实请求校验** → 通过则保存，失败则回显原因 |
| `/quota list` | 列出已配置账号及其 cookie 剩余有效期 |

`getArgumentCompletions` 提供 `all` / `set` / `list` 与账号名补全。

### 4.3 cookie 录入流程（`/quota set ark-a`）

1. `ctx.ui.editor("粘贴 Ark-A 的 cookie：", "")` 多行输入
2. 解析 cookie：能否提取 `csrfToken`？`digest` 的 `exp` 还剩多久？
3. 立刻发一次真实请求：
   - 成功 → 保存（chmod 600）→ `notify("ark-a 已更新：session 12.5% · weekly 37.3% · monthly 100.0%", "info")` → footer 立即刷新
   - `NotLogin` → `notify("cookie 无效或已过期，请重新登录后复制", "error")`，**不保存**
   - `InvalidCSRFToken` → `notify("cookie 不完整，请复制完整 cookie", "error")`，**不保存**
4. 保存前校验该 cookie 对应的 `AccountID` 是否与已存的另一账号重复 → 重复则警告（防呆：避免两个账号贴成同一个）

---

## 5. 边界与失败行为

| 场景 | 行为 |
|---|---|
| cookie 剩余 < 2h | footer 该段前置 ⚠️；`session_start` 时 toast 一次 |
| cookie 已过期 | footer 显示 `Ark-A ✗ cookie 过期`，**不影响** Ark-B 段 |
| 网络错误 | 保留上次成功数据 + 标 `stale`（footer 加 `~` 前缀），不清空 |
| 接口返回未知结构 | 该段显示 `✗ 接口变更`，其余段落不受影响 |
| 未配置 cookie 的 Ark 账号 | 显示 `Ark-B 未配置`（不报错、不刷屏） |
| 并发查询 | 全部 provider 并发发出，单个失败不影响其他 |
| 非 TUI 模式（`-p`） | 不发布 footer；不发 toast；缓存逻辑照常 |
| 定时刷新失败 | 指数退避（5min → 30min 上限），不每 tick 重试 |
| 账号值重复 | `/quota set` 时检测并拒绝 |

---

## 6. 安全边界

- cookie 与 key 存 `~/.pi/agent/multi-quota.json`，写入时 `chmod 600`
- **cookie 原文绝不出现在**：日志、`notify` 文本、错误信息、session 条目、footer
- 错误信息只保留**错误码**（`NotLogin` / `InvalidCSRFToken`），不回显响应体
- 请求 host 白名单硬编码：`console.volcengine.com`、`opencode.ai`、`api.deepseek.com`；其余一律拒绝
- 拒绝重定向（`redirect: "error"`），防止凭据被转发到其他 host
- 不读取浏览器 cookie 数据库、不启动浏览器、不调用任何外部 CLI
- Zen / DeepSeek 的 key **复用 pi 已有配置**（`ctx.modelRegistry.getProviderAuth`），不重复存储

---

## 7. Tech Stack

| 项 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node ≥ 20 | pi 扩展运行环境 |
| 语言 | TypeScript（无构建步骤） | pi 用 jiti 直接加载 `.ts` |
| 加载方式 | `pi.extensions: ["./src/index.ts"]` | 无需 esbuild 产物 |
| 测试 | `node --import tsx --test`（Node 内置 test runner） | 零测试框架依赖 |
| 类型检查 | `tsc --noEmit` | |
| 依赖 | 仅 `peerDependencies: @earendil-works/pi-coding-agent` | 运行时零第三方依赖 |
| 包名 | `pi-multi-quota` | `pi-quota` 已被 npm 占用 |

---

## 8. Commands

```bash
# 安装（本地路径，写入全局 settings.json）
pi install /home/user/workspace/pi-multi-quota

# 开发期试跑（不写入 settings）
pi -e /home/user/workspace/pi-multi-quota/src/index.ts

# 测试
cd /home/user/workspace/pi-multi-quota && npm test
# → node --import tsx --test test/*.test.ts

# 类型检查
npm run typecheck
# → tsc --noEmit

# 卸载
pi remove /home/user/workspace/pi-multi-quota
```

---

## 9. Project Structure

```
/home/user/workspace/pi-multi-quota/
├── package.json
├── tsconfig.json
├── README.md              # 用法、cookie 获取步骤（含截图说明位）
├── SPEC.md                # 本文件
├── src/
│   ├── index.ts           # 扩展入口
│   ├── types.ts
│   ├── cookie.ts
│   ├── config.ts
│   ├── registry.ts
│   ├── cache.ts
│   ├── footer.ts
│   └── sources/
│       ├── ark.ts
│       ├── opencode.ts
│       └── deepseek.ts
└── test/
    ├── cookie.test.ts
    ├── ark.test.ts
    ├── opencode.test.ts
    ├── deepseek.test.ts
    └── footer.test.ts
```

---

## 10. Code Style

- 全中文注释；标识符英文
- 无 `any`；外部响应解析一律走显式类型守卫（如 `asObject` / `asNumber`），失败抛出带上下文的错误
- 纯函数优先：解析、裁剪、格式化逻辑与 IO 分离，便于单测
- 单个源文件不超过 ~200 行

---

## 11. Testing Strategy

**框架**：Node 内置 test runner（`node --import tsx --test`），零第三方依赖。

**覆盖重点**（纯函数层，不打真实网络）：

| 测试文件 | 覆盖 |
|---|---|
| `cookie.test.ts` | `csrfToken` 提取；`digest` exp 解码；畸形 cookie 报错 |
| `ark.test.ts` | 正常响应解析；`NotLogin` / `InvalidCSRFToken` 错误分支；HTTP 200 但带 Error 的识别；未知 `Level` 的容忍 |
| `opencode.test.ts` | 三窗口解析；`rate-limited` 保留可见；未知 status 降级为 note |
| `deepseek.test.ts` | 多币种分离；金额保持字符串精度；`is_available: false` 分支 |
| `footer.test.ts` | 宽度预算三级裁剪顺序；stale 前缀；错误段与正常段共存 |

**网络层**：通过注入 `fetch` 实现（依赖注入），测试中传假实现，不 mock 全局。

**不做的测试**：不写真实网络集成测试（会消耗额度、且依赖真实 cookie 寿命）。

---

## 12. Boundaries

**Always**
- 改动后跑 `npm test` + `npm run typecheck`
- 新增 source 适配器时同步补 `test/<source>.test.ts`
- cookie / key 相关代码路径必须脱敏
- 错误信息只保留错误码

**Ask first**
- 新增第三方运行时依赖（当前目标是零依赖）
- 修改 host 白名单
- 改动 `~/.pi/agent/multi-quota.json` 的配置结构（破坏兼容）
- 发布到 npm

**Never**
- 在任何输出（日志 / notify / session / 错误 / footer）中出现 cookie 原文
- 读取浏览器 cookie 数据库或启动外部进程
- 向白名单外的 host 发送凭据
- 跟随重定向
- 把额度数据写进 session 或发送给模型

---

## 13. Success Criteria

全部为可验证条件：

- [ ] **SC1** 当前模型为 `volcengine` 时，footer 同时出现 `Ark-A` 与 `Ark-B` 两段，且各自含 5h / wk / mo 三个百分比
- [ ] **SC2** `/model` 切到 `opencode-go-ds` 后，footer 在 1 秒内变为 OpenCode 段，Ark 段消失
- [ ] **SC3** `/quota all` 一次输出 4 条账号数据（Ark-A / Ark-B / Zen / DeepSeek）
- [ ] **SC4** 拿一个**人为篡改的 cookie** 执行 `/quota set ark-a`，回显 `NotLogin` 且**不写入**配置
- [ ] **SC5** 用真实 cookie 执行 `/quota set ark-a`，成功保存，且文件权限为 `600`
- [ ] **SC6** 全文检索 session 文件与扩展输出，**搜不到** cookie 原文（`digest` 值）与任何 API key
- [ ] **SC7** 断开网络后 footer 显示上次数据并带 `stale` 标记，不显示空白或崩溃
- [ ] **SC8** `npm test` 与 `npm run typecheck` 全绿
- [ ] **SC9** `pi -e` 加载扩展后无报错；`/quota`、`/quota all`、`/quota set`、`/quota list` 四个命令均响应

---

## 14. Open Questions

| # | 问题 | 处理方式 |
|---|---|---|
| 1 | Ark-B 账号的真实 cookie 尚未取得（访谈中只验证了 Ark-A 的账号 `1000000001`） | 实现完成后由本人登录第二个账号补齐；未配置时按「未配置」降级 |
| 2 | 定时器在 pi 长会话中的内存/句柄清理细节（`ctx.shutdown` 钩子） | 实现阶段按 `extensions.md` 的 long-lived resources 章节处理 |
| 3 | footer 60 字符预算在窄终端（80 列）下的实际观感 | 实现后实测调整；已预留 `maxWidth` 可配置 |
| 4 | `digest` 是否存在 HTTP 层自动续期接口 | **明确排除出 MVP**；若日后觉得每日贴 cookie 过烦，另开一轮调研 |

---

## 15. 明确不做（Out of Scope）

- 不发布到 npm
- 不做自动 cookie 续期、不读浏览器 cookie 库、不启动浏览器
- 不依赖 `arkcli` / 火山 SSO
- 不支持 Ark / OpenCode / DeepSeek 之外的供应商
- 不做历史用量统计、图表、趋势
- 不把额度信息传给模型，也不写入 session
