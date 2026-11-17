# 发布与验收手册

本文件不随 npm 包发布（不在 `package.json` 的 `files` 里），只给维护者用。

## 0. 当前状态（2026-11-16）

| 项 | 状态 |
|---|---|
| 仓库 | <https://github.com/D0cx0011/dsh-apple-write>（main `6eda6b0`，tag `v0.3.0`） |
| 包名 `dsh-apple-write` | npm 上 **未被占用**（`registry.npmjs.org` 返回 404，实测） |
| 版本 | `0.3.0` |
| 运行时依赖 | 0（只用 `fetch` + `node:` 内置） |
| 打包体积 | 57.5 kB tgz / 12 个文件 |
| `npm test` | 通过（93 个假服务器请求，全链路） |
| 隐私闸门 | `node scripts/privacy-check.mjs` 通过（0 命中） |
| 真实账号验证 | 通过（中国大陆区账号，CalDAV + CardDAV 双通道，见 README「实测记录」） |
| 干净 profile 安装 | 通过（本地路径安装 + compose + import 三步实测） |

## 1. 发布前必做

### 1.1 仓库地址（已填）

`package.json` 的 `repository` / `homepage` / `bugs` 已指向 `D0cx0011/dsh-apple-write`。换仓库时同步改这三处。

### 1.2 隐私复核（每次发布都跑）

```powershell
node scripts/privacy-check.mjs
```

它按 `npm pack --dry-run --json` 的**真实文件清单**扫描：真实邮箱域、本机绝对路径、iCloud 分片主机、大陆手机号、App 专用密码形状、GitHub token 形状、私钥块，以及**运行期从 `git config` 读到的账号指纹**（不写死在仓库里）。仓库 owner 这种公开身份会放行。

提交身份也必须是不泄露真邮箱的那个：

```powershell
git config user.name  D0cx0011
git config user.email D0cx0011@users.noreply.github.com
```

### 1.3 一个全新 profile 的安装验收

`dsh plugin add` 会先做一次 **DSH 版本/peer 校验**（`engines.dsh` + `@deepseek-ai/*` peer），不满足直接拒绝安装。这个包用一个临时的 probe profile 实测过一次：

```powershell
dsh plugin --profile probe add C:\绝对路径\dsh-apple-write
dsh --profile probe --dump-config | Select-String apple-write   # 应能看到 patch 里那一行
```

装完后把 `cordis.patch.yml` 配置段写进 probe profile，用 `dsh --profile probe "跑一次 apple_targets"` 确认两条通道都返回。

> 注意：`engines.dsh` 之前写成 `>=0.2.0`，而当前运行时是 `0.1.5-rc.1`——那个值会**在 pnpm 之前**被拒（`incompatible-version`），已改为 `>=0.1.5-rc.1`。以后每次 DSH 大版本升级都要回头确认这个字段。

## 2. 发布

```powershell
cd plugin
node scripts/privacy-check.mjs   # 必须 0 命中
npm test                         # 必须绿
npm pack --dry-run               # 核对内容：lib/ + patch + README + CHANGELOG + LICENSE + 三个自检脚本
npm publish --access public
```

`prepublishOnly` 会自动再跑一次 `npm test`，测试红了发不出去。隐私闸门不在 `prepublishOnly` 里（它要在打包前跑，属于人工闸），别漏。

## 3. 发布后自检（三分钟）

```powershell
# 1) 从 registry 装（不是本地路径），验证 pnpm 能解析
dsh plugin --profile probe2 add dsh-apple-write

# 2) 能不能加载
dsh --profile probe2 --dump-config | Select-String apple-write

# 3) 真机：填配置 → 重启 → 跑 apple_targets
```

三条都过才算发成功。只做第 1 步容易漏掉「装上了但加载不了」——那通常是 `cordis.patch.yml` 的 `name` 与 `package.json` 的 `name` 不一致。

## 4. 版本策略

- **补丁号**：文档、错误文案、探测脚本。
- **次版本号**：新工具、新参数、行为变更（例如幂等键从标题改成标题+到期）。
- **主版本号**：工具改名、配置项语义变更、依赖 DSH 大版本。
- `CHANGELOG.md` 每次发版都要有段落，按 `新增 / 修复 / 打包 / 移除` 分。

## 5. 已知陷阱

| 陷阱 | 说明 |
|---|---|
| `github:` 安装被 pnpm 拦 | pnpm ≥10 默认拒绝执行 git 依赖的 `prepare` 脚本。本仓库把 `lib/` 提交进 git，所以**不需要构建**，但要保持这个约定：不要加 `prepare` 脚本。 |
| peer 依赖不会被自动安装 | profile 的 `pnpm-workspace.yaml` 是 `autoInstallPeers: false`。`@deepseek-ai/dsh-tools` / `schemastery` 靠 DSH 在 `$DSH_HOME/profiles/node_modules` 维护的 fallback 目录解析（`dsh-app-boot` 的 `healProfilesModuleFallback` 每次启动重建），所以 peer 写 `*` 是安全的；**不要**改成具体版本，否则换 DSH 版本会误报不兼容。 |
| `devDependencies` 与运行时无关 | 只为 `npm test` 能跑（测试要用 `validateJsonSchemaValue`）。发布包不含 node_modules。 |
| 本工作区的安装方式 | 当前 desktop profile 用的是 junction → 本目录，属于开发态。正式发布后应改成 `dsh plugin add dsh-apple-write` 的 registry 安装。 |
