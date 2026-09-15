# pi-multi-quota

在 pi 的 footer 里实时显示**当前模型所属供应商**的额度 —— 纯 HTTP、零子进程、零运行时依赖。

为「一个 pi 里同时挂着多个供应商、且其中一家有多个账号」的场景设计。

---

## 支持范围

| 供应商 | 显示内容 | 凭据来源 |
|---|---|---|
| **火山方舟 Ark**（Coding Plan） | 5h / 周 / 月 已用百分比 | 控制台 cookie（手动维护，见下） |
| **OpenCode Go**（Zen） | rolling（footer 显示为 5h）/ weekly / monthly 百分比 | 复用 pi 已配置的 API key |
| **DeepSeek** | 账户余额（CNY / USD 分别显示） | 复用 pi 已配置的 API key |

footer 跟随当前模型：用 Ark 的模型时显示 Ark 的**全部账号**，切到 OpenCode 就整段换成 OpenCode。

---

## 安装

从 GitHub 安装：

```bash
pi install https://github.com/wyouwd1/pi-multi-quota
```

本地克隆安装（开发用，在仓库根目录执行）：

```bash
git clone https://github.com/wyouwd1/pi-multi-quota
cd pi-multi-quota
pi install .
```

装完重启 pi 或 `/reload`。

> footer 只在当前模型属于上表三家供应商之一时出现；切到其它 provider 时 footer 段会清空，这是预期行为。

卸载时用**与安装时相同的 source 标识**：

```bash
pi remove https://github.com/wyouwd1/pi-multi-quota   # 从 GitHub 安装的
pi remove .                                          # 从克隆目录安装的（在仓库根目录执行）
```

---

## 命令

| 命令 | 作用 |
|---|---|
| `/quota` | 展开**当前供应商**明细（各窗口百分比 + 重置倒计时 / 余额明细） |
| `/quota all` | 一次查询三家（Ark 每个账号 + Zen + DeepSeek）。仅**当前 provider** 对应的数据源能取到凭据，其余两家显示 `✗ 未配置` |
| `/quota set <账号>` | 粘贴并**当场校验** Ark cookie（校验失败绝不保存） |
| `/quota list` | 列出已配置账号及其 cookie 剩余有效期 |
| `/quota close` | 关闭详情面板 |

---

## 配置 Ark cookie（重点）

Ark 的额度只能通过**控制台接口**读取，需要一份浏览器 cookie。这是唯一需要手动维护的东西。

### 首次配置

1. 浏览器打开并登录：`https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan`
2. `F12` → Console → 输入 `document.cookie` → 回车 → **复制整段结果**
3. **先创建账号槽位**：编辑 `~/.pi/agent/multi-quota.json`（不存在则新建；若 `~/.pi/agent/` 目录也不存在，先 `mkdir -p ~/.pi/agent`），内容为：

   ```json
   {"ark":{"accounts":[{"id":"ark-a","provider":"<你在 pi 里配置的 provider id>","cookie":""}]}}
   ```

   `/quota set` 要求槽位**已存在**，所以必须先建槽位、再用 `/quota set ark-a` 粘贴 cookie；
   此时 `cookie` 留空字符串即可（footer 会显示该槽位「未配置」而不是报错）。
   `provider` 填你在 pi 里配置的 provider id（可在 pi 的 provider / 模型配置里查到）。它只用于识别「当前模型对应哪个 Ark 账号」，决定 footer 在窄终端下优先保住哪个账号的完整显示；数据源由模型 baseUrl 的 host 决定，填错不会报错、额度照常显示，但 footer 会退化为单窗口形态。
   建好文件后建议 `chmod 600 ~/.pi/agent/multi-quota.json`（手工创建时权限取决于 umask；扩展自己写入时会自动收紧到 600）。
4. 回到 pi 运行 `/quota set ark-a` → 粘贴 → 回车
5. 扩展会**立刻发一次真实请求**校验：
   - 通过 → 保存（文件权限 `600`）→ footer 立即刷新，并回显该账号当前额度
   - 失败 → 告诉你具体原因（`cookie 过期` / `cookie 不完整`），**不会写入任何东西**

### 两个账号（或更多）

⚠️ **火山 SSO 的登录态是浏览器级共享的** —— 在同一个浏览器里登录账号 B，会把账号 A 的 cookie 顶掉。

所以要同时持有两份有效 cookie，需要：

- 一个用正常窗口，另一个用**隐身窗口 / 另一个浏览器 / 另一台设备**
- 先按「首次配置」第 3 步在 `~/.pi/agent/multi-quota.json` 的 `accounts` 数组里追加 `ark-b` 槽位（`id` 为 `ark-b`、`provider` 填账号 B 对应的 pi provider id、`cookie` 留空）
- 分别登录 → 各自复制一次 cookie → 分别 `/quota set ark-a`、`/quota set ark-b`

**防呆**：扩展会读取 cookie 里的 `AccountID`，如果新 cookie 与另一个槽位是**同一个火山账号**，会拒绝保存并提示 —— 避免两个槽位贴成同一份。

### cookie 会过期

cookie 里的 `digest` 是 SSO access token，**约 24 小时失效**。

- 剩余 < 2 小时：开会话时 **toast 提示一次**（footer 不额外标记）
- 已失效：footer 显示 `Ark-A ✗ cookie 过期`（**不影响** Ark-B 等其他账号）
- 处理：重新走一遍上面的步骤，`/quota set ark-a` 覆盖即可

用 `/quota list` 可以随时查看各账号还剩多久。

---

## 配置文件

路径：`~/.pi/agent/multi-quota.json`（写入时自动设为 `600`）

```json
{
  "ark": {
    "accounts": [
      { "id": "ark-a", "provider": "volcengine",   "cookie": "<粘贴的整段 cookie>" },
      { "id": "ark-b", "provider": "volcengine-2", "cookie": "<粘贴的整段 cookie>" }
    ]
  }
}
```

- `id`：账号标识，决定 footer 里的显示名（`ark-a` → `Ark-A`）
- `provider`：你在 pi 里的 provider id，仅用于把「当前模型」对应到 Ark 账号（footer 裁剪优先级）；数据源按 baseUrl host 判定，与它无关
- `cookie`：留空字符串表示「尚未配置」，footer 会显示该槽位未配置而不是报错

> OpenCode 与 DeepSeek 的密钥**不需要写进这个文件** —— 扩展通过 pi 的凭据系统读取，不重复存储。

---

## 状态与错误对照

| footer 显示 | 含义 | 怎么办 |
|---|---|---|
| `Ark-A 5h 13% wk 37% mo 100%` | 正常 | — |
| `~Ark-A 5h 13% …` | 本次刷新失败，显示的是**上次成功数据** | 等待自动退避重试 |
| `Ark-A ✗ 未配置` / `Zen ✗ 未配置` | Ark：该槽位 cookie 为空；Zen / DeepSeek：当前 provider 的 key 取不到（如 `/quota all` 里的非当前供应商） | Ark 用 `/quota set ark-a`；Zen / DeepSeek 切到对应 provider 即恢复 |
| `Ark-A ✗ cookie 过期` | `digest` 已失效（约 24h） | `/quota set ark-a` |
| `Ark-A ✗ cookie 不完整` | 缺 `csrfToken`，多半是没复制全 | 重新复制**整段** cookie |
| `✗ 接口变更` | 响应结构不认识（供应商改了接口） | 需要更新本扩展 |
| `✗ 网络错误` / `✗ 超时` | 网络问题 | 自动退避（5min → 30min 封顶） |

---

## 安全边界

- cookie 只存在本地 `~/.pi/agent/multi-quota.json`，权限 `600`
- **cookie 原文不会出现在**日志、错误信息、footer、session 文件里 —— 错误信息只保留错误码
- 只向固定的供应商 host 发送凭据：`console.volcengine.com`（Ark）/ `opencode.ai`（OpenCode）/ `api.deepseek.com`（DeepSeek）。三家 URL 都是源码常量；Ark 另在发起前复核目标 host，白名单外直接拒绝
- 三个供应商的请求都带 `redirect: "error"`：拒绝跟随重定向，防止凭据被转发到其他 host
- **不**读取浏览器 cookie 数据库、**不**启动浏览器、**不**调用任何外部 CLI、**不**起子进程
- 额度数据不写入 session，也不发送给模型

---

## 开发

前置要求：Node **>= 20**（见 `package.json` 的 `engines`），且已安装 pi 编码助手。
仓库不含 `node_modules`，先装依赖再跑测试：

```bash
npm install     # 安装 tsx / typescript 等开发依赖
npm test        # node --import tsx --test test/*.test.ts
npm run typecheck
pi -e ./src/index.ts   # 临时加载（不写入 settings）
```

### 结构

```
src/
├── index.ts          # 扩展入口：事件订阅 + /quota 命令族
├── types.ts          # 跨模块类型契约
├── registry.ts       # baseUrl host → 数据源分派 + 凭据解析
├── cookie.ts         # Ark cookie 解析（csrfToken / AccountID / digest exp）
├── config.ts         # 配置文件读写（原子写入 + 权限 600 + 脱敏）
├── cache.ts          # TTL 缓存 + stale 保留 + 并发去重 + 指数退避
├── footer.ts         # footer 渲染 + 宽度裁剪 / 详情渲染
└── sources/
    ├── ark.ts        # 控制台 GetCodingPlanUsage（POST + csrf）
    ├── opencode.ts   # /zen/go/v1/usage
    └── deepseek.ts   # /user/balance
```

设计与决策记录见 [`SPEC.md`](./SPEC.md)。

### 已知限制

- Ark cookie **必须手动更新**（约每 24 小时一次）；未实现自动续期 —— 控制台接口无公开刷新链路
- 只支持上述三个供应商，新增供应商需要写一个 `src/sources/*.ts` 适配器并在 `registry.ts` 注册
- 不做历史用量统计与图表
