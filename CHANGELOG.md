# Changelog

## 0.3.2 — 2026-11-22

把「排序」从只读视图变成真的能改列表顺序。

### 新增

- **`reminder_sort` 的 `writeOrder`**：把排好的顺序写进每条提醒的 `X-APPLE-SORT-ORDER`。
  这个属性就是 Apple 提醒事项存「手动顺序」的地方——在一份 234 条的活列表上实测，
  204 条带这个属性（整数 5…200，步长 1）。之前只写了「iCloud 没有排序属性」的结论，
  那是只看了两条已完成条目的误判；活动条目恰好都没写这个字段，跟「不存在」是两回事。
- `patchVCalendar` 支持 `sortOrder`：替换而不是追加，且插在第一个子组件之前（VALARM 不能被打乱）。

### 实测

- 对真实账号的 Reminders 列表（10 条未完成）跑了一次 `writeOrder: true`：写入 1…10，
  回读顺序与截止时间顺序一致，闹钟与备注原样保留。
- 手机上是否按这个顺序显示，取决于提醒事项 App 的「排序方式」是否设成「手动」——
  这条工具注释和 README 都写明了。

## 0.3.1 — 2026-11-22

跟着 DSH 升到 0.2.2-rc.5 做的一次维护 + 一个新工具。

### 新增

- **`reminder_sort`**：把一份列表按时间排好并分桶返回（已过期 / 今天 / 明天 / 本周 / 以后 / 无日期），
  可换个排序键（`by: 'title'`）或倒序。`fillDue: true` 会把「写在标题里的日期」搬进真正的 `DUE`
  字段——`11.23 计算机网络 实验3` 这种条目的病根就是日期没落到日期字段上，补上之后
  任何按时间排序才有意义。默认 dry-run，必须显式 `dryRun: false` 才写；单次最多 50 条。
- `scripts/compat-check.mjs`（`npm run compat`）：把当前安装的 DSH 里 `app.asar` 中的
  `@deepseek-ai/*` 解到临时目录，用**它自带的那份** `dsh-tools` 跑一遍 `apply()`，确认每个工具
  都能注册。DSH 一升级就跑这条，不用猜 semver。

### 维护

- 针对 DSH **0.2.2-rc.5** 复验：12 个工具在真实的 `dsh-tools@0.2.2-rc.5` 上全部注册成功
  （`defineTool` / `output.schema` / `output.render` 契约未变），bundle patch 层照常注入，
  `--dump-config` 里能看到 `# == dsh-apple-write`。
- devDependencies 对齐到 `dsh-tools@0.2.2-rc.5` / `schemastery@3.19.0`，`npm test` 现在跑在
  当前 SDK 上，而不是半年前那份。
- 行为变化提示：`presentCall()` 在 0.2.x 里只对 Host 本地消费方有效，Web Client 改为自己从
  参数和结果派生卡片，所以工具卡片样式由客户端决定，插件侧不再影响它。

### 说明

- iCloud 的 VTODO 没有排序属性（已实测），所以 `reminder_sort` 不会去动手机上的显示顺序，
  只修数据与返回值。README 的「能力边界」一节写清楚了这一点。

## 0.3.0 — 2026-11-16

首个准备发布的版本。相对内部原型 0.2.0，重点是把「能写」变成「写坏了能修、重跑不重复、闹钟真的响」。

### 新增

- `reminder_add_many` 的 `skip_existing` 改为按 **标题 + 到期日** 判重（原来只看标题，会把同名不同周的两条吞掉一条）。
- `reminder_remove_many`：一次删多条（uid 或精确标题），逐条报告 removed / notFound / failed。
- `reminder_add` / `reminder_add_many` 支持 `alarm`（VALARM）：`"15m"` / `"1h"` / `"2d"` / `"0"`（到点）。
- `reminder_update` 支持 `new_alarm` / `clear_alarm`；`complete: true` 现在同时写 `STATUS:COMPLETED` 和 `COMPLETED:<UTC>`。
- `contact_list`（CardDAV `addressbook-query`，一次取回全部名片）与 `contact_remove`（同名歧义拒绝）。
- `reminder_list_items` 报告每条是否带闹钟。
- `apple_targets` 只在两条通道都关掉时才不注册；输出里不再有假的 `notes` 通道。

### 修复

- **瞬时断连会直接把工具调用打死**：iCloud 在短时间内收到一串请求时会直接断 TCP，实测第 8 个请求报 `fetch failed`。现在传输层失败会退避重试（最多 2 次，250/700 ms），401/403/404 这类"服务器真的回答了"的结果**不重试**（避免把密码错误重试成锁号）；列表活跃度探测也从并发改成串行，少制造突发。

- **浮动时间被当 UTC 换算**：iPhone 自己创建的提醒存的是没有 `Z` 的本地时间，读回时被 +8 小时（21:00 显示成次日 05:00）。现在带 `Z` 才换算。
- **折行（folded）资源解析**：读侧按物理行解析，超过 75 octet 的标题被截断；改标题时只替换第一行，旧尾巴留在下面拼成新标题。现在先 unfold 再解析 / patch，输出统一重新 fold。
- **属性操作不区分组件**：`DESCRIPTION` 在 VALARM 里也合法，改备注会打到闹钟通知正文上；`clear_notes` 会把闹钟正文一起删掉。现在所有属性操作限定在 VTODO 这一层。
- **新属性插在子组件之后**（违反 RFC 5545 §3.6）：现在插到第一个子组件之前。
- **REPORT 失败被吞成「没有找到」**：401/403/5xx 会被报成「这条不存在」。现在保留首个错误，全部读失败就抛出真因。
- **`timeoutMs` 只是标签**：10 个工具都不接收 `exec.signal`。现在整条链路透传到 `fetch`，批量循环在每轮前检查中止。
- CalDAV 侧补齐 `.icloud.com → .icloud.com.cn` 区域回退（原来只有 CardDAV 有）。
- 资源 href 拼接归一化尾斜杠（集合 URL 不带 `/` 时会写到父路径）。
- `deleteTodo` / `deleteContact` 带 `If-Match`；412 明确报「读取后被改过，未删除」。
- `buildVCalendar({ completed: true })` 不再产生两条 `STATUS`。
- `probe.mjs` 改读 `vtodoDeclared`（原来读一个已不存在的 `confidence` 字段，「服务端未声明 VTODO」的保留永不打印）。
- `unescapeText` 改成单趟替换，字面 `\\n` 不会被当成换行。
- 401 发生在跨源重定向之后时给出明确提示（那一跳会丢掉 `Authorization`）。

### 文档

- `README.md` 改成双层结构：**前半是给普通用户的**（三步确认前提、粘贴式安装指令、装完看到什么、8 条常见问题、怎么卸载），**后半是技术参考**（权威配置 schema、工具契约、写入语义、故障映射表、验证命令、实测证据）。面向的分发人群是"用 agent 办事但不读源码"的人，所以前半不出现 CalDAV / VTODO 这类术语。
- 前置条件从"技术边界"改写成三条可操作的检查，每条都给了用户自己能做的动作；判断不了的部分收敛到"让助手跑一次自检"，不再要求用户理解协议。

### 打包

- 补 `LICENSE`（MIT）、`CHANGELOG.md`、`.gitignore`、`scripts.test` / `prepublishOnly`。
- `engines.dsh` 修正为 `>=0.1.5-rc.1`。**原值 `>=0.2.0` 会让 DSH 的安装期版本校验直接拒绝安装**（当前运行时是 0.1.5-rc.1）。
- `files` 带上 LICENSE / CHANGELOG；`npm test` 直接可跑。

### 移除

- IMAP 备忘录通道（从未实现）不再出现在工具面、README 与 `apple_targets` 输出里。

## 0.2.0 — 内部原型

CalDAV VTODO + CardDAV vCard 两条写通道，8 个工具：`reminder_add`、`reminder_add_many`、`reminder_lists`、`reminder_list_items`、`reminder_remove`、`reminder_update`、`contact_add`、`apple_targets`。
