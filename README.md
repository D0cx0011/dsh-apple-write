# dsh-apple-write

从 **DeepSeek Harness** 往 iPhone 的 **提醒事项**（CalDAV VTODO）和 **通讯录**（CardDAV vCard）写东西。一份 App 专用密码覆盖两条通道，跨平台（Windows / macOS / Linux 一致，不需要 Mac、不需要 EventKit、不需要常驻 iPhone）。

定位一句话：**在 Windows 上让 agent 批量整理 iPhone 提醒事项，重跑不重复。**

```
Agent → DSH 插件 → HTTPS → caldav.icloud.com / contacts.icloud.com → iPhone
```

## 适用账号前提（先读这条，决定它能不能用）

提醒事项在 2019 年 iOS 13 那次「升级」里被 Apple 从 CalDAV 迁到了 CloudKit。**CalDAV 只能写「未升级」的旧提醒列表**。所以三个条件必须同时满足：

1. 账号**没有**执行过提醒事项升级（CalDAV 上还留着带 VTODO 的列表）；
2. **高级数据保护（ADP）关闭**——开启后提醒事项端到端加密，服务器端拿不到明文；
3. 用的口令是 **App 专用密码**（19 位、四个连字符），不是 Apple ID 登录密码。

不确定就先跑 `node probe.mjs`（见下文「自检」）。已经全部迁移到 CloudKit 的账号，CalDAV 侧只剩空壳日历，这个插件写进去的东西 iPhone 提醒事项里永远看不到——这不是 bug，是协议边界。

## 工具

| 工具 | 作用 | 落到哪 |
|---|---|---|
| `reminder_add` | 加一条提醒（标题 / 备注 / 到期 / 优先级 / 闹钟） | CalDAV VTODO |
| `reminder_add_many` | 一次加多条，`skip_existing` 让周期重跑幂等 | CalDAV VTODO |
| `reminder_lists` | 列出可写的提醒列表 + 活跃度 + 推荐项 | CalDAV |
| `reminder_list_items` | 读列表内容（标题子串 / 到期窗 / 完成状态 / 有无闹钟） | CalDAV |
| `reminder_update` | 就地改字段（不重建资源，闹钟和附件不丢） | CalDAV |
| `reminder_remove` | 删一条（同名歧义时拒绝，不猜） | CalDAV |
| `reminder_remove_many` | 一次删多条（按 uid 或精确标题） | CalDAV |
| `contact_add` | 加一个联系人 | CardDAV vCard 3.0 |
| `contact_list` | 按姓名 / 号码 / 邮箱搜联系人 | CardDAV |
| `contact_remove` | 删一个联系人（同名歧义时拒绝） | CardDAV |
| `apple_targets` | 两条通道的可写目标一览（各通道独立报告，互不掩盖） | 两条 |

## 安装

```bash
# npm（发布后）
dsh plugin --profile desktop add dsh-apple-write

# 直接从 GitHub（仓库提交了 lib/，安装期零构建）
dsh plugin --profile desktop add github:<user>/dsh-apple-write

# 本地开发目录（必须绝对路径）
dsh plugin --profile desktop add C:\path\to\plugin
```

`dsh plugin` 本质是 pnpm 的前向包装：装完它会把包名补进 profile 的 `dsh.profile.bundles`。验证装载：

```bash
dsh --profile desktop --dump-config | Select-String apple-write
```

## 配置

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里加这一段（口令**不要**写进文件，用环境变量）：

```yaml
- insert:
    - id: apple-write
      name: 'dsh-apple-write'
      config:
        appleId: 'you@example.com'
        appPasswordEnv: 'APPLE_ASP'      # 口令放环境变量
        reminderList: 'Reminders'        # 默认写入的列表名
        # contactsBook: '通讯录'          # 留空 = 账号里的第一本通讯录
        # caldavUrl:  'https://caldav.icloud.com/'    # 非 iCloud 才需要改
        # carddavUrl: 'https://contacts.icloud.com/'
        # enableReminders: true
        # enableContacts: true
        # timeoutMs: 20000
```

```powershell
[Environment]::SetEnvironmentVariable('APPLE_ASP','xxxx-xxxx-xxxx-xxxx','User')
```

改完重启 DSH。`appPassword`（明文写进配置）也能用，但那份文件是磁盘明文，环境变量更省事也更容易吊销。

## 自检

装完先跑 `apple_targets`。两条通道独立报告，一条失败不掩盖另一条。输出长这样（示例数据）：

```
✓ reminders: 工作[12 条 2025-03-02], 生活[38 条 2026-02-11], 家庭[仅日历], 学习[仅日历]
✓ contacts: 通讯录
```

判读要点：**两条都声明支持 VTODO 的列表里，只有一条是 iPhone 提醒事项正在显示的**。另一条多半是 Reminders→CloudKit 迁移遗留的僵尸列表——`last activity` 停在多年前，iOS 只在日历里显示它。`reminder_lists` 会把活跃度证据和推荐项一起给你，写之前先看一眼。

不想启动 DSH 也能探测：

```powershell
$env:APPLE_ID='you@example.com'; $env:APPLE_ASP='xxxx-xxxx-xxxx-xxxx'
node probe.mjs            # 只读发现：有没有可写列表、通讯录能不能读
node probe.mjs --write    # 加一次真实往返（PUT → GET → DELETE，自动清理）
```

## 语义要点（都是踩过的坑）

- **`due` 三种形状**：`2026-11-12`（全天，`VALUE=DATE`）、`2026-11-12T09:00:00+08:00`（绝对时刻，存成 UTC）、`2026-11-12T09:00:00`（**没有时区就当本地时间**，返回值里会回显解析结果）。读回时相反：iPhone 自己创建的条目存的是**浮动本地时间**（没有 `Z`），这类值原样回显，不做时区换算——把它当 UTC 转一次会整整偏 8 小时。
- **闹钟（VALARM）**：`alarm: "15m" | "1h" | "2d" | "0"`（`0` = 到点提醒），也接受 iCalendar 的 `-PT15M`。不传 `alarm` 就是**静默条目**——列表里有，但不会响。
- **幂等重跑**：`reminder_add_many` 的 `skip_existing` 按「标题 + 到期日」判重，不是只看标题。所以「交周报（本周）」和「交周报（下周）」不会互相吞掉，而同一条重跑两次只会写一次。
- **就地修改**：`reminder_update` 不重建资源，只改你点名的属性——`VALARM`、`URL`、`RELATED-TO`、`X-APPLE-*` 全部原样保留。属性操作按组件深度限定，改备注不会打到闹钟的通知正文上。
- **并发保护**：更新带 `If-Match`（etag），服务端没给 etag 时返回值里会出现 `conditional: false`，告诉你这次写没有并发保护。
- **同名歧义**：`reminder_remove` / `reminder_update` / `contact_remove` 遇到同名多条时**拒绝执行**并列出候选 uid，不做模糊匹配。

## 已知边界

- **不建模**：重复规则（RRULE）、子任务（RELATED-TO）、标签、附件、位置提醒。更新时这些属性会原样保留，但插件不会替你创建或修改它们。
- **闹钟**只写 `ACTION:DISPLAY` + 相对 `TRIGGER`；`AUDIO` / 邮件 / 多闹钟不在范围内。
- **没有备忘录通道**：iCloud 原生备忘录是私有 CRDT，只能走 IMAP 账户的 Notes 文件夹，本版本未实现。
- **一个账号一套配置**：多账号请用多个 profile。
- **CalDAV / CardDAV 都是未文档化表面**：Apple 可以随时收紧，写失败要有降级方案（自建 Radicale / Nextcloud 也能用，改 `caldavUrl` 即可）。
- **App 专用密码是全账号级凭据**：泄露就在 appleid.apple.com 一键吊销。

## 测试

```bash
npm test              # selftest.mjs：假 CalDAV + 假 CardDAV，全链路 93 个请求，不联网
node live_probe.mjs   # 对真实 iCloud 用故意错的口令打一发，验 401/403 的错误映射
node probe.mjs        # 独立 go/no-go 探测（真实凭据，默认只读）
```

`selftest` 覆盖：发现链、VTODO 过滤、三态组件判定、PUT 生成（UTC 换算 / 全天 / 折行 ≤75 octet）、闹钟、卡片生成、读侧折行还原、浮动时间回显、就地 patch（组件作用域 / 属性在子组件之前 / 完成后补 COMPLETED 时间戳）、批量幂等键、同名歧义拒绝、401/403/507/无 VTODO/未公布组件集、`.icloud.com.cn` 区域回退、瞬时断连重试（且 401 不重试）、信号中止，以及**每个工具的输出 schema + render**。

## 实测记录（2026-11，真实 iCloud 账号）

| 项 | 结果 |
|---|---|
| 账号 | 真实 iCloud 账号（中国大陆区）；入口填 `caldav.icloud.com`，分片主机由发现链自动跟随 |
| 列表 | 多个日历集合，其中两个声明 VTODO：一个是活列表，一个是迁移遗留的僵尸列表 |
| 写入形状 | PUT 后 GET 回读为 `BEGIN:VTODO`，`DUE` 以 UTC 落库（`DUE:20261201T010000Z`） |
| 闹钟 | `alarm: "30m"` → 落库 `BEGIN:VALARM … TRIGGER:-PT30M … END:VALARM`，回读能识别 |
| 通讯录 | `addressbook-query` 一次取回全量联系人，UID / FN / TEL 正常解析 |
| 僵尸列表 | 真实存在，且只有活跃度能把它和活列表区分开（两者都声明 VTODO） |

> 本仓库与 npm 包内**不含**任何真实账号信息：没有 Apple ID、没有口令、没有真实列表名/联系人/待办内容。发布前用 `node scripts/privacy-check.mjs` 复核。

## 发布

见仓库根目录 `PUBLISHING.md`。

## 许可

MIT。
