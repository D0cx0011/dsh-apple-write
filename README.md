# dsh-apple-write

**让你的 AI 助手帮你批量整理 iPhone 的「提醒事项」和「通讯录」。**

比如一次说「把下周的三件事都加进去」「把买菜清单里过期的删掉」「这个人的电话存进通讯录」——你说人话，助手动手，你在 iPhone 上看到结果。

不用 Mac，不用装 iPhone App，不用手动同步。改完重启，手机几秒内自己出现。

---

## 它适合你吗

| 你会这么说 | 它就干这个 |
|---|---|
| 「帮我把这 12 件事加进提醒事项」 | 一次写 12 条，到点会响 |
| 「每个周一都提醒我交周报」 | 一条一条加，重跑不会重复 |
| 「把已经完成的都删掉」 | 按条件批量清理 |
| 「提醒我明天 9 点开会」 | 写成带闹钟的到点提醒 |
| 「这个人电话存一下」 | 存进 iPhone 通讯录 |
| 「我提醒事项里现在有哪些？」 | 读出来给你看 |

**它不做的**：重复提醒（每周/每月那种自动循环）、子任务、标签、附件、位置提醒、备忘录。这些内容你手动建的它不会弄坏，但也不会替你建。

---

## 开始前，先确认 3 件事

这是苹果的硬限制，不是插件挑食。三条全中才能用，缺一条写进去你也看不到。

**1. 你的提醒事项没被「升级」过**

2019 年 iOS 13 那次，苹果把提醒事项从旧接口搬到了新接口，旧接口只能写没搬走的老列表。如果你的账号在旧接口上还能看到列表（哪怕只剩一个），就能用。

> 不用你自己判断。装完之后让助手跑一次自检，它会把「能不能写、写进哪个列表」直接告诉你。

**2. 关闭「高级数据保护」**

iPhone 上：`设置` → 最上面你的名字 → `iCloud` → `高级数据保护` → 如果是开着的，**关掉**。开着的时候提醒事项是端到端加密的，服务器拿不到内容，任何外部工具都写不进去。

**3. 用一个「App 专用密码」，不是你的 Apple ID 密码**

电脑上打开 <https://appleid.apple.com> →
`登录与安全` → `App 专用密码` → `生成` → 随便写个名字（比如 `agent`）→ 拿到一串像 `abcd-efgh-ijkl-mnop` 的东西。

**这串东西给助手用，用完随时能在这个页面一键作废**，作废后你 Apple ID 本身完全不受影响。别把 Apple ID 真实密码给任何工具。

---

## 装：把下面这段整个发给你的助手

复制 → 发给你的 agent → 把它改好的两处填上 → 发送。

```text
帮我装一个 DSH 插件 dsh-apple-write，它让我能从你这里往我 iPhone 的
提醒事项和通讯录写东西。请按顺序做，每步告诉我结果：

1) 安装：
   dsh plugin --profile desktop add dsh-apple-write
   （装不上就试 github:D0cx0011/dsh-apple-write）

2) 配凭据。口令不要写进任何配置文件，走环境变量：
   - 我的 Apple ID：<你的 Apple ID 邮箱>
   - 口令短名：APPLE_ASP
   - 指导我把口令存成用户环境变量（Windows 用
     [Environment]::SetEnvironmentVariable）
   然后在 ~/.dsh/profiles/desktop/cordis.patch.yml 里加：
     - insert:
         - id: apple-write
           name: 'dsh-apple-write'
           config:
             appleId: '<你的 Apple ID 邮箱>'
             appPasswordEnv: 'APPLE_ASP'

3) 重启 DSH，然后调 apple_targets 自检，把结果原样贴给我。

4) 如果自检里出现两个都「支持待办」的列表，先别写东西，
   把每个列表的名字、条数、最后活动时间列给我，我来确认哪个是我
   手机上真正在用的。确认后把它的名字填进 config 的 reminderList。

5) 全部通过后，加一条测试提醒「agent 自检 OK」，到期时间设成明天，
   然后读回来给我看，确认后删掉。

任何一步报错，把报错的原文贴给我，不要自己猜着改配置。
```

装完自检通过，你就可以直接说人话了，不用再碰配置。

---

## 装完之后你会看到什么

自检成功长这样（列表名和数字是你自己的）：

```
✓ 提醒事项：工作[12 条 2025-03-02]、生活[38 条 2026-02-11]、家庭[只有日历]
✓ 通讯录：通讯录
```

看到 `✓` 就是通了。

**「只有日历」是什么意思**：那个列表在苹果那边是个空壳，写了也不会出现在你手机提醒事项里。助手应该自动跳过它。

**遇到两个都「支持待办」的列表**：一个是真在用的，一个是以前从提醒事项搬走时留下的空壳。只有"最后活动时间"能区分它们——停在好几年前的就是空壳。让助手把两个都报给你，你选。

---

## 常见问题

**写进去了，iPhone 上没看到**
八成是写进了空壳列表（见上一条），或者你的账号已经整体搬到新接口了（前提 1 不满足）。让助手调 `reminder_lists` 看活跃度，挑那个最近有动静的列表名填进 `reminderList`。

**报错说认证失败 / 口令被拒绝**
- 用的是 Apple ID 真实密码，不是 App 专用密码 → 去 appleid.apple.com 生成一个
- 口令抄错了（是 19 位、四组四字符、带三个连字符）→ 重新生成
- 高级数据保护还开着 → 前提 2

**加了但到点不响**
加的时候没说要闹钟。跟助手说「设个闹钟，提前 15 分钟」，它会带上。不说的默认是静默条目——在列表里，但不响。

**时间差了 8 小时**
你在加的时候给了时区，它按 UTC 存的，读回来的显示差 8 小时属于正常换算；但如果你看到的是"明明写 9 点显示成 17 点"并且怎么都不对，跟助手说「用本地时间」，它会把它当墙上时间原样存。

**同一条提醒出现了好几遍**
说明助手没走批量接口。跟它说「用 reminder_add_many，带上 skip_existing」，重跑多少次都只写一条。

**能不能改成已完成 / 改内容 / 删掉**
都能。改的时候只动你说那个字段，闹钟和附件不会丢。删的时候如果同名有好几条，它会拒绝并列出候选让你选，不会瞎删。

**通讯录能存什么**
名字、电话（可以多个）、邮箱、公司、备注。苹果通讯录里其它花哨字段（头像、地址、生日）这版不动。

**我该担心安全吗**
口令只在你本机，插件只跟苹果服务器说话，不经过任何第三方。插件包里没有任何账号信息（发布前用 `scripts/privacy-check.mjs` 自动核对过）。不放心就随时去 appleid.apple.com 把那个 App 专用密码作废，一秒失效。

**怎么卸载**
```
dsh plugin --profile desktop remove dsh-apple-write
```
再把 `cordis.patch.yml` 里那一段删掉、环境变量删掉就行。iPhone 上已有的提醒不会消失——它们本来就是你账号里的数据。

---

## 一句话总结

装上 → 自检 → 说人话。剩下的交给助手。

---

# 技术参考

> 下面这段是给 **agent 和开发者** 看的：配置项的权威定义、工具契约、写入语义、故障映射、验证证据。
> 人不用读。人只需要读上面的部分。

## 0. 安装变体

```bash
# npm（registry 发布后）
dsh plugin --profile desktop add dsh-apple-write

# 直接从 GitHub（lib/ 已提交，安装期零构建）
dsh plugin --profile desktop add github:D0cx0011/dsh-apple-write

# 本地开发目录（只接受绝对路径）
dsh plugin --profile desktop add C:\path\to\plugin
```

`dsh plugin` 是 pnpm 的前向包装；装完它会把包名补进 profile 的 `dsh.profile.bundles`。验证装载：

```bash
dsh --profile desktop --dump-config | Select-String apple-write
```

安装期会先检查 `engines.dsh` 与 `@deepseek-ai/*` peerDependencies，不匹配直接 `incompatible-version` 挡住，不会走到 pnpm。peer 用 `*` 是安全的：DSH 每次启动重建 `$DSH_HOME/profiles/node_modules` fallback，裸导入能解析。

## 1. 配置项（权威 schema）

写在 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- insert:
    - id: apple-write
      name: 'dsh-apple-write'
      config:
        appleId: 'you@example.com'      # 必填
        appPasswordEnv: 'APPLE_ASP'     # 环境变量名；优先级高于 appPassword
        reminderList: 'Reminders'       # 调用未指定 list 时的默认目标
        # contactsBook: '通讯录'        # 留空 = 账号里的主通讯录
        # caldavUrl:  'https://caldav.icloud.com/'
        # carddavUrl: 'https://contacts.icloud.com/'
        # enableReminders: true
        # enableContacts: true
        # timeoutMs: 20000
```

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `appleId` | string | **必填** | Apple ID 邮箱；自建 DAV 时填账号名 |
| `appPasswordEnv` | string | — | 口令所在的环境变量名，**优先于** `appPassword`；口令在调用时解析，启动后设也能生效 |
| `appPassword` | string | — | 明文口令（19 位、4 连字符）。文件是磁盘明文，能用 env 就别用它 |
| `caldavUrl` | string | `https://caldav.icloud.com/` | 非 iCloud 才需要改（Radicale / Nextcloud 同样可用） |
| `carddavUrl` | string | `https://contacts.icloud.com/` | 同上 |
| `reminderList` | string | — | 调用省略 `list` 时的目标列表名 |
| `contactsBook` | string | 主通讯录 | 通讯录名 |
| `enableReminders` | boolean | `true` | 关掉则不注册 7 个 reminder 工具 |
| `enableContacts` | boolean | `true` | 关掉则不注册 3 个 contact 工具 |
| `timeoutMs` | number | `20000` | 单请求超时 |

两通道都关掉时 `apple_targets` 不注册。两个口令键都缺时插件只 warn 不崩，工具调用时抛结构化错误。

## 2. 工具契约

| 工具 | 关键入参 | 落点 |
|---|---|---|
| `reminder_add` | `title`、`notes`、`due`、`priority`、`alarm`、`list` | CalDAV VTODO |
| `reminder_add_many` | `items[]`、`skip_existing`、`list` | CalDAV VTODO |
| `reminder_lists` | — | CalDAV（含活跃度证据 + 推荐项） |
| `reminder_list_items` | `query`、`dueFrom`、`dueTo`、`includeCompleted`、`limit` | CalDAV |
| `reminder_update` | `uid` \| `title`、`new_*`、`complete`、`clear_*` | CalDAV（就地 patch） |
| `reminder_remove` | `uid` \| `title` | CalDAV |
| `reminder_remove_many` | `uids[]`、`titles[]` | CalDAV |
| `contact_add` | `name`、`phone`（逗号分隔多号）、`email`、`org`、`note`、`book` | CardDAV vCard 3.0 |
| `contact_list` | `query`、`book`、`limit` | CardDAV |
| `contact_remove` | `uid` \| `name`、`book` | CardDAV |
| `apple_targets` | — | 两通道并行探测，各自独立报告 |

约定：

- 每个工具都有 `output.schema` + `output.render`；`exec.signal` 透传到 `fetch`，取消会中断在途请求。
- 结构化错误统一 `isError: true`，消息里带 HTTP 状态与下一步动作；`.status` / `.body` 保留在 `error.cause` 上供程序判断。
- `reminder_remove_many` / `reminder_remove` 的标题匹配是**精确** `SUMMARY` 匹配，多条命中即拒绝并返回候选 uid；绝不模糊删。

## 3. 写入语义

- **`due` 三种形状**：`2026-11-12`（全天，`VALUE=DATE`）／`2026-11-12T09:00:00+08:00`（绝对时刻，落库 UTC）／`2026-11-12T09:00:00`（无时区 = 本地墙上时间，返回值回显解析结果）。
- **读回方向相反**：iPhone 自建条目存的是浮动本地时间（`DUE:` 不带 `Z`）。这类值**原样回显、不做时区换算**——当 UTC 转一次会整整偏 8 小时。只有带 `Z` 的值才格式化。
- **闹钟**：`alarm: "15m" | "1h" | "2d" | "0"`（`0` = 到点），也接受 iCalendar 的 `-PT15M`。落库为 `ACTION:DISPLAY` + 相对 `TRIGGER`。不传 = 静默条目。
- **幂等键**：`skip_existing` 按「标题 + 到期日」判重，不是只看标题——「交周报（本周）」和「交周报（下周）」不互吞，同一条重跑只写一次。
- **就地 patch**：`reminder_update` 不重建资源，只改点名属性；`VALARM`、`URL`、`RELATED-TO`、`X-APPLE-*` 原样保留。属性操作**按组件深度限定**（`propDepth`），改备注不会打到 VALARM 的 `DESCRIPTION` 上；新属性插在首个嵌套 `BEGIN:` 之前，不会写进 `VALARM` 块之后（RFC 5545 §3.6）；`STATUS:COMPLETED` 时补 `COMPLETED:` 时间戳。
- **并发**：更新/删除带 `If-Match`（etag）。服务端没给 etag 时返回值带 `conditional: false`，明示本次写没有并发保护。
- **重试**：只对传输层失败（`/network error|timed out/`）退避重试 2 次（250/700 ms）。**401/403/404 绝不重试**——服务器已经回答了，重试只会把"密码错"变成"账号被锁"。`reminder_lists` / `apple_targets` 的列表活跃度探测是串行的，避免突发请求触发 iCloud 直接断连。
- **折行**：写入时长行按 75 octet 折（RFC 5545），读侧先 `unfold()` 再取值，UTF-8 多字节不会被切断。

## 4. 边界与不建模

- **不建模**：`RRULE`、子任务（`RELATED-TO`）、标签、附件、位置提醒。更新时这些属性原样保留，但不创建、不修改。
- **闹钟**只写 `ACTION:DISPLAY` + 相对 `TRIGGER`；`AUDIO`、邮件、多闹钟不在范围内。
- **备忘录无通道**：iCloud 原生备忘录是私有 CRDT，只能走 IMAP 的 Notes 文件夹，本版本未实现。
- **单账号单配置**：多账号用多个 profile。
- **CalDAV / CardDAV 都是未文档化表面**：Apple 可随时收紧；自建 Radicale / Nextcloud 改 `caldavUrl` 即可降级。
- **App 专用密码是全账号级凭据**：泄露即去 appleid.apple.com 一键吊销。

## 5. 故障映射

| 现象 | 真实原因 | 处置 |
|---|---|---|
| 401 | 无可用凭据被接受 | 确认是 App 专用密码而非账号密码；确认 ADP 已关 |
| 403 | 凭据被拒 | 同上；检查口令是否被吊销 |
| 跨域重定向后 401 | 分片主机不认区域主机 | 已内置 `.icloud.com.cn` 区域回退；报告里带原 URL 与最终 URL |
| 412（更新/删除） | 读后到写之间被别人改过（etag 变了） | 重新读一次再改，避免覆盖手机上的编辑 |
| 412（创建） | 同 UID 已存在 | 换 UID 或先删 |
| 507 | 账号 iCloud 存储配额用尽 | 清空间或升级套餐 |
| 列表声明 VTODO 但写入不显示 | 迁移遗留的僵尸列表 | 用 `reminder_lists` 的 `last activity` 区分，选推荐项 |
| `fetch failed` 单次 | iCloud 突发限流断连 | 已内置退避重试；仍失败则串行化调用 |
| 输出含 `conditional: false` | 服务端未返回 etag | 本次写无并发保护，高并发场景需自行串行 |

## 6. 验证

```bash
npm test                     # selftest.mjs：假 CalDAV + 假 CardDAV，93 个请求，不联网
node scripts/privacy-check.mjs   # 待发布文件清单个人信息扫描
node probe.mjs               # 独立 go/no-go 探测（真实凭据，默认只读）
node probe.mjs --write       # 加一次真实往返（PUT → GET → DELETE，自动清理）
node live_probe.mjs          # 对真实 iCloud 用故意错的口令打一发，验 401/403 映射
node scripts/acceptance.mjs [--write]   # 对"安装产物"跑验收，默认只读
```

`selftest` 覆盖：发现链、VTODO 过滤、三态组件判定、PUT 生成（UTC 换算／全天／折行 ≤75 octet）、闹钟、卡片生成、读侧折行还原、浮动时间回显、就地 patch（组件作用域／属性位置／`COMPLETED` 戳）、批量幂等键、同名歧义拒绝、401/403/507／无 VTODO／未公布组件集、`.icloud.com.cn` 区域回退、瞬时断连重试（且 401 不重试）、信号中止，以及**每个工具的输出 schema + render**。

`acceptance.mjs` 默认指向**已安装的** `~/.dsh/profiles/probe/node_modules/dsh-apple-write/lib/index.js`（`--lib` 可覆盖），验的是分发出去的那份代码，不是开发目录。

## 7. 实测记录（2026-11，真实 iCloud 账号）

| 项 | 结果 |
|---|---|
| 账号 | 真实 iCloud 账号（中国大陆区）；入口填 `caldav.icloud.com`，分片主机由发现链自动跟随 |
| 列表 | 多个日历集合，其中两个声明 VTODO：一个活列表、一个迁移遗留的僵尸列表 |
| 写入形状 | PUT 后 GET 回读为 `BEGIN:VTODO`，`DUE` 以 UTC 落库（`DUE:20261201T010000Z`） |
| 闹钟 | `alarm: "30m"` → 落库 `BEGIN:VALARM … TRIGGER:-PT30M … END:VALARM`，回读能识别 |
| 通讯录 | `addressbook-query` 一次取回全量联系人，`UID` / `FN` / `TEL` 正常解析 |
| 僵尸列表 | 真实存在，且只有活跃度能把它和活列表区分开（两者都声明 VTODO） |
| 端到端验收 | GitHub 装 → 写（含闹钟）→ 回读命中 → 删除 → 复读归零，PASS |

> 本仓库与 npm 包内**不含**任何真实账号信息：没有 Apple ID、没有口令、没有真实列表名／联系人／待办内容。

## 8. 发布

见仓库根目录 `PUBLISHING.md`。

## 9. 许可

MIT。
