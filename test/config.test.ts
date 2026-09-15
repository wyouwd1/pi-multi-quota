/**
 * src/config.ts 测试。
 *
 * 所有用例都在 mkdtemp 隔离目录里跑，并通过 PI_MULTI_QUOTA_CONFIG 覆盖配置路径，
 * 绝不读写真实的 ~/.pi/agent/multi-quota.json。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  configPath,
  findArkAccountById,
  findArkAccountByProvider,
  loadConfig,
  redact,
  saveConfig,
  upsertArkAccount,
  type ArkAccountConfig,
  type QuotaConfig,
} from "../src/config.js";

/** 隔离目录；配置文件放在其下的 nested/ 子目录，用于验证父目录自动创建。 */
let tmpDir: string;
let configFile: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-multi-quota-config-"));
  configFile = path.join(tmpDir, "nested", "multi-quota.json");
  savedEnv = process.env["PI_MULTI_QUOTA_CONFIG"];
  process.env["PI_MULTI_QUOTA_CONFIG"] = configFile;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env["PI_MULTI_QUOTA_CONFIG"];
  else process.env["PI_MULTI_QUOTA_CONFIG"] = savedEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("configPath：默认指向 ~/.pi/agent/multi-quota.json，环境变量可覆盖", () => {
  delete process.env["PI_MULTI_QUOTA_CONFIG"];
  const fallback = path.join(os.homedir(), ".pi", "agent", "multi-quota.json");
  assert.equal(configPath(), fallback);
  assert.ok(path.isAbsolute(configPath()));

  process.env["PI_MULTI_QUOTA_CONFIG"] = "   ";
  assert.equal(configPath(), fallback, "空白覆盖值应回落到默认路径");

  process.env["PI_MULTI_QUOTA_CONFIG"] = configFile;
  assert.equal(configPath(), configFile);
});

test("loadConfig：文件不存在时返回默认空结构且不创建文件", () => {
  assert.deepStrictEqual(loadConfig(), { ark: { accounts: [] } });
  assert.equal(fs.existsSync(configFile), false);
});

test("loadConfig：缺字段的结构被补齐为合法默认值", () => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const cases: Array<[string, unknown]> = [
    ["{}.json", {}],
    ["ark-null.json", { ark: null }],
    ["ark-empty.json", { ark: {} }],
    ["top-level-array.json", []],
    ["top-level-null.json", null],
  ];
  for (const [, payload] of cases) {
    fs.writeFileSync(configFile, JSON.stringify(payload));
    assert.deepStrictEqual(loadConfig(), { ark: { accounts: [] } }, JSON.stringify(payload));
  }

  // 非法账号条目被丢弃，合法条目原样保留
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      ark: { accounts: [{ id: "ark-a" }, "junk", null, { id: "ark-b", provider: "volcengine-2", cookie: "a=1" }] },
    }),
  );
  assert.deepStrictEqual(loadConfig(), {
    ark: { accounts: [{ id: "ark-b", provider: "volcengine-2", cookie: "a=1" }] },
  });
});

test("loadConfig：JSON 损坏时抛错，且不覆盖用户文件", () => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const broken = '{"ark":{"accounts":[{"id":"ark-a","cookie":"digest=SECRET';
  fs.writeFileSync(configFile, broken);

  assert.throws(
    () => loadConfig(),
    (err: Error) => {
      assert.ok(err.message.includes("不是合法 JSON"));
      assert.ok(!err.message.includes("digest=SECRET"), "错误信息不得回显文件内容");
      return true;
    },
  );
  assert.equal(fs.readFileSync(configFile, "utf8"), broken, "损坏文件必须原样保留");
});

test("saveConfig：递归建父目录、权限 600、可与 loadConfig 往返", () => {
  const cfg: QuotaConfig = {
    ark: {
      accounts: [
        { id: "ark-a", provider: "volcengine", cookie: "a=1" },
        { id: "ark-b", provider: "volcengine-2", cookie: "b=2" },
      ],
    },
  };
  assert.equal(fs.existsSync(path.dirname(configFile)), false);
  saveConfig(cfg);

  assert.deepStrictEqual(loadConfig(), cfg);
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(configFile)), ["multi-quota.json"], "不留临时文件");

  // 覆盖已有文件后权限仍为 600
  saveConfig({ ark: { accounts: [] } });
  assert.deepStrictEqual(loadConfig(), { ark: { accounts: [] } });
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
});

test("upsertArkAccount：同 id 新增时不改入参，返回新对象", () => {
  const arkA: ArkAccountConfig = { id: "ark-a", provider: "volcengine", cookie: "a=1" };
  const base: QuotaConfig = { ark: { accounts: [arkA] } };

  const next = upsertArkAccount(base, { id: "ark-b", provider: "volcengine-2", cookie: "b=2" });

  assert.deepStrictEqual(next.ark.accounts, [arkA, { id: "ark-b", provider: "volcengine-2", cookie: "b=2" }]);
  assert.equal(base.ark.accounts.length, 1, "入参不得被原地修改");
  assert.notEqual(next, base);
  assert.notEqual(next.ark.accounts, base.ark.accounts);
});

test("upsertArkAccount：同 id 替换 provider 与 cookie，且不动入参对象", () => {
  const arkA: ArkAccountConfig = { id: "ark-a", provider: "volcengine", cookie: "old=1" };
  const base: QuotaConfig = { ark: { accounts: [arkA, { id: "ark-b", provider: "volcengine-2", cookie: "b=2" }] } };

  const next = upsertArkAccount(base, { id: "ark-a", provider: "volcengine-new", cookie: "new=2" });

  assert.deepStrictEqual(next.ark.accounts, [
    { id: "ark-a", provider: "volcengine-new", cookie: "new=2" },
    { id: "ark-b", provider: "volcengine-2", cookie: "b=2" },
  ]);
  assert.deepStrictEqual(arkA, { id: "ark-a", provider: "volcengine", cookie: "old=1" });
});

test("findArkAccountById / findArkAccountByProvider：命中与未命中", () => {
  const arkA: ArkAccountConfig = { id: "ark-a", provider: "volcengine", cookie: "a=1" };
  const cfg: QuotaConfig = { ark: { accounts: [arkA, { id: "ark-b", provider: "volcengine-2", cookie: "b=2" }] } };

  assert.equal(findArkAccountById(cfg, "ark-a"), arkA);
  assert.equal(findArkAccountByProvider(cfg, "volcengine-2")?.id, "ark-b");
  assert.equal(findArkAccountById(cfg, "ark-z"), undefined);
  assert.equal(findArkAccountByProvider(cfg, "opencode-go-ds"), undefined);
});

test("redact：digest / csrfToken / sk- / ark- / Bearer 一律替换", () => {
  const digestValue = "AbCd1234+/9876xyzSECRETVALUE==";
  const csrfToken = "0123456789abcdef0123456789abcdef";
  const out = redact(
    [
      `digest=${digestValue}; csrfToken=${csrfToken}`,
      "sk-live-abcdef1234567890",
      "ark-1234567890abcdef",
      "Authorization: Bearer abcdef1234567890",
      '{"csrfToken":"0123456789abcdef0123456789abcdef"}',
    ].join("\n"),
  );

  assert.ok(!out.includes(digestValue), "digest 值不得残留");
  assert.ok(!out.includes(csrfToken), "csrfToken 值不得残留");
  assert.ok(!out.includes("sk-live-abcdef1234567890"), "sk- key 不得残留");
  assert.ok(!out.includes("ark-1234567890abcdef"), "ark- key 不得残留");
  assert.ok(!out.includes("abcdef1234567890"), "Bearer token 不得残留");
  assert.ok(out.includes('<redacted>'));
  // 键名保留（非 cookie 形态的零散片段），便于定位问题来源
  assert.ok(out.includes('"csrfToken":"<redacted>"'));
});

test("redact：整段账号 cookie 文本被抹掉", () => {
  // AccountID 为合成占位值（非真实火山账号 ID），仅用于验证 redact 会整段抹除
  const cookie =
    "digest=AbCd1234+/9876xyzSECRETVALUE==; csrfToken=0123456789abcdef0123456789abcdef; " +
    "AccountID=1000000001; volc_locale=zh-CN; JSESSIONID=ABC123DEF456";
  const out = redact(`Ark 校验失败，cookie=${cookie}（HTTP 200）`);

  assert.ok(!out.includes("AbCd1234+/9876xyzSECRETVALUE=="));
  assert.ok(!out.includes("1000000001"), "整段 cookie 一并抹掉，不只抹 digest");
  assert.ok(!out.includes("ABC123DEF456"));
  assert.ok(out.includes("<redacted>"));
  assert.ok(out.includes("Ark 校验失败"));
});

test("redact：不误伤普通文本", () => {
  const plain = [
    "Ark-A 5h 13% wk 37% mo 100%",
    "重置时间 2027-01-18T11:45:30.000Z",
    "HTTP 200 NotLogin：未登录",
    "provider=volcengine，账号 ark-a 已配置",
    "配置文件 ~/.pi/agent/multi-quota.json 不存在",
    "已过期 20 分钟",
  ].join("\n");
  assert.equal(redact(plain), plain);
});
