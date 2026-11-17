#!/usr/bin/env node
/**
 * Apple 通道 go/no-go 探测 —— 不需要 DSH，不需要装任何东西。
 *
 * 回答两个问题：
 *   ① 这个 Apple ID 的 CalDAV 上还有没有可写的提醒列表？
 *   ② 这个账号的 CardDAV 通讯录能不能写？
 *
 * 凭据走环境变量，不进命令行历史：
 *
 *   $env:APPLE_ID  = 'you@example.com'
 *   $env:APPLE_ASP = 'xxxx-xxxx-xxxx-xxxx'
 *   node probe.mjs                # 只读发现
 *   node probe.mjs --write        # 发现 + 真实往返（自动清理）
 *
 * 兼容旧变量名 ICLOUD_USER / ICLOUD_APP_PASSWORD。
 * 可选：APPLE_CALDAV_URL / APPLE_CARDDAV_URL / APPLE_REMINDER_LIST / APPLE_CONTACTS_BOOK
 */
import { RemindersClient, CalDAVError } from './lib/caldav.js';
import { ContactsClient, CardDAVError } from './lib/carddav.js';

const user = process.env.APPLE_ID || process.env.ICLOUD_USER;
const pass = process.env.APPLE_ASP || process.env.ICLOUD_APP_PASSWORD;
const caldavUrl = process.env.APPLE_CALDAV_URL || process.env.ICLOUD_BASE || 'https://caldav.icloud.com/';
const carddavUrl = process.env.APPLE_CARDDAV_URL || 'https://contacts.icloud.com/';
const wantedList = process.env.APPLE_REMINDER_LIST || process.env.ICLOUD_LIST;
const wantedBook = process.env.APPLE_CONTACTS_BOOK;
const doWrite = process.argv.includes('--write');
const timeoutMs = 20000;

const YES = '\u2705';
const NO = '\u274c';
const MAYBE = '\u26a0\ufe0f';

const line = (s = '') => process.stdout.write(s + '\n');
const step = (n, total, s) => line(`\n[${n}/${total}] ${s}`);
const ok = (s) => line(`      OK   ${s}`);
const warn = (s) => line(`      WARN ${s}`);
const bad = (s) => line(`      FAIL ${s}`);

function requireCredentials() {
  if (user && pass) return true;
  bad('缺少凭据。');
  line('');
  line('PowerShell:');
  line("  $env:APPLE_ID  = 'you@example.com'");
  line("  $env:APPLE_ASP = 'xxxx-xxxx-xxxx-xxxx'");
  line('  node probe.mjs --write');
  process.exitCode = 2;
  return false;
}

async function main() {
  if (!requireCredentials()) return;

  line('='.repeat(66));
  line('Apple 写入通道 go/no-go 探测');
  line(`账号:    ${user}`);
  line(`CalDAV:  ${caldavUrl}`);
  line(`CardDAV: ${carddavUrl}`);
  line(`口令:    ${pass.replace(/-/g, '').length} 位（App 专用密码去连字符应为 16 位）`);
  line('='.repeat(66));

  const caldav = new RemindersClient({ username: user, password: pass, baseUrl: caldavUrl, timeoutMs });
  const carddav = new ContactsClient({ username: user, password: pass, baseUrl: carddavUrl, timeoutMs });

  // ---------------------------------------------------------------- CalDAV
  let caldavHome = null;
  let collections = [];
  let caldavError = null;

  step(1, 5, 'CalDAV：解析 principal / calendar-home-set（顺带验认证）');
  try {
    caldavHome = await caldav.discoverHome();
    ok(`calendar-home-set = ${caldavHome}`);
    const host = new URL(caldavHome).host;
    if (/^p\d+-caldav/.test(host)) ok(`落在分片 ${host}（跟随服务端，未硬编码）`);
  } catch (err) {
    caldavError = err;
    bad(`CalDAV 不可用：${err.message}`);
  }

  step(2, 5, 'CalDAV：枚举集合，读 supported-calendar-component-set');
  if (!caldavError) {
    try {
      collections = await caldav.listCollections();
      if (collections.length === 0) warn('一个集合都没有。账号异常，或 CalDAV 已被整体关闭。');
      for (const c of collections) {
        const tag = c.vtodos === 'yes' ? 'VTODO  ' : c.vtodos === 'no' ? 'EVENT  ' : 'UNKNOWN';
        const comps = c.componentsKnown ? c.components.join('+') : '(未公布)';
        line(`      [${tag}] ${JSON.stringify(c.name)}  ${comps}`);
      }
      const unknown = collections.filter((c) => c.vtodos === 'unknown');
      if (unknown.length) {
        warn(`${unknown.length} 个集合不公布组件类型 —— 中国区 iCloud 常态，只有试写能定论。`);
      }
    } catch (err) {
      caldavError = err;
      bad(`枚举失败：${err.message}`);
    }
  } else {
    line('      跳过（上一步已失败）');
  }

  // --------------------------------------------------------------- CardDAV
  let carddavHome = null;
  let books = [];
  let carddavError = null;

  step(3, 5, 'CardDAV：解析 addressbook-home-set 并枚举通讯录');
  try {
    carddavHome = await carddav.discoverHome();
    ok(`addressbook-home-set = ${carddavHome}`);
    books = await carddav.listAddressbooks();
    if (carddav.regionAdjusted) ok('国际域不可达，已自动切到 .com.cn 区域（无需配置）');
    if (books.length === 0) warn('没有通讯录集合。检查 iCloud 通讯录是否开启。');
    for (const b of books) line(`      [BOOK   ] ${JSON.stringify(b.name)}`);
  } catch (err) {
    carddavError = err;
    bad(`CardDAV 不可用：${err.message}`);
  }

  // ------------------------------------------------------------ 迁移痕迹
  step(4, 5, '检查「提醒事项已迁移到 CloudKit」的痕迹');
  const fossil = collections.find(
    (c) => c.vtodos === 'no' && /reminders|提醒/i.test(c.name) && !/task|todo/i.test(c.name),
  );
  if (fossil) {
    warn(`疑似迁移残留：${JSON.stringify(fossil.name)}（只含 VEVENT）`);
    warn('说明提醒事项列表已不在 CalDAV 上，只剩日历壳子。');
  } else if (collections.some((c) => c.vtodos === 'yes')) {
    ok('存在明确声明 VTODO 的集合');
  } else {
    warn('没有集合声明 VTODO，也没有明显残留标记 —— 需要写入测试定论。');
  }

  // --------------------------------------------------------------- 写入
  const wrote = { reminder: null, contact: null };
  step(5, 5, doWrite ? '写入往返测试：PUT → GET → DELETE' : '写入测试（未启用）');

  if (!doWrite) {
    line('      只做了只读发现。加 --write 做一次真实往返（会自动删除）。');
  } else {
    // --- reminders ---
    const candidates = collections.filter((c) => c.vtodos !== 'no');
    if (!candidates.length) {
      bad('提醒事项：没有可写候选集合，跳过。');
    } else {
      const confirmed = candidates.filter((c) => c.vtodos === 'yes');
      const plan = wantedList
        ? candidates.filter((c) => c.name.toLowerCase() === wantedList.toLowerCase())
        : confirmed.length
          ? confirmed
          : candidates;
      if (plan.length === 0) bad(`提醒事项：指定的列表 ${JSON.stringify(wantedList)} 不存在。`);

      for (const target of plan) {
        line(
          `      提醒目标: ${JSON.stringify(target.name)}${target.vtodos === 'unknown' ? '（未公布类型，试写）' : ''}`,
        );
        let created;
        try {
          created = await caldav.createTodo(
            {
              title: `[probe] DSH 往返测试 ${new Date().toISOString().slice(0, 19)}`,
              notes: 'probe.mjs 创建，自动删除。看到这条说明写入链路通了。',
              due: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
            },
            { list: target.name },
          );
        } catch (err) {
          warn(`PUT 被拒：${err.message}`);
          if (err.status === 401 || err.status === 403 || err.status === 507) break;
          continue;
        }
        ok(
          `PUT 成功 ${created.uid}.ics (HTTP ${created.status})${created.vtodoDeclared === false ? ' [服务端未声明 VTODO]' : ''}`,
        );
        // 直接 GET 回读，不用 REPORT：iCloud 搜索索引是最终一致的。
        const rb = await caldav.request(created.href, { method: 'GET' });
        ok(
          rb.res.status === 200 && /BEGIN:VTODO/.test(rb.text)
            ? 'GET 回读为 VTODO'
            : `GET 回读 ${rb.res.status}（不影响结论）`,
        );
        await cleanup(caldav, created.href, '提醒事项');
        wrote.reminder = {
          list: created.list,
          unverified: created.vtodoDeclared === false,
          stale: created.stale,
        };
        break;
      }
    }

    // --- contacts ---
    if (books.length === 0) {
      bad('通讯录：没有可写集合，跳过。');
    } else {
      const target = wantedBook ? books.find((b) => b.name.toLowerCase() === wantedBook.toLowerCase()) : books[0];
      if (!target) {
        bad(`通讯录：指定的 ${JSON.stringify(wantedBook)} 不存在（可选：${books.map((b) => b.name).join(', ')}）`);
      } else {
        line(`      通讯录目标: ${JSON.stringify(target.name)}`);
        try {
          const created = await carddav.createContact(
            {
              name: `[probe] DSH ${new Date().toISOString().slice(11, 19)}`,
              phone: '+8613800138000',
              note: 'probe.mjs 创建，自动删除。',
            },
            { book: target.name },
          );
          ok(`PUT 成功 ${created.uid}.vcf (HTTP ${created.status})`);
          const rb = await carddav.request(created.href, { method: 'GET' });
          ok(
            rb.res.status === 200 && /BEGIN:VCARD/.test(rb.text)
              ? 'GET 回读为 vCard'
              : `GET 回读 ${rb.res.status}（不影响结论）`,
          );
          await cleanup(carddav, created.href, '通讯录');
          wrote.contact = { book: created.book };
        } catch (err) {
          bad(`通讯录写入失败：${err.message}`);
        }
      }
    }
  }

  verdict({ caldavHome, collections, books, caldavError, carddavError, wrote, doWrite });
}

async function cleanup(client, href, label) {
  try {
    const del = await client.request(href, { method: 'DELETE' });
    if (del.res.status >= 200 && del.res.status < 300) ok(`DELETE 清理成功 (HTTP ${del.res.status})`);
    else warn(`DELETE 返回 ${del.res.status} —— 请手动到「${label}」里删掉那条 [probe] 条目`);
  } catch (err) {
    warn(`DELETE 失败：${err.message} —— 请手动到「${label}」里删掉那条 [probe] 条目`);
  }
}

function verdict({ caldavHome, collections, books, caldavError, carddavError, wrote, doWrite }) {
  line('');
  line('='.repeat(66));
  line('结论');
  line('='.repeat(66));

  // 提醒事项
  if (caldavError) {
    line(`${NO} 提醒事项：${caldavError.message}`);
  } else if (wrote.reminder) {
    line(
      `${YES} 提醒事项：写入已落地 → 列表 ${JSON.stringify(wrote.reminder.list)}` +
        (wrote.reminder.unverified ? '（服务端未公布组件类型，但接受了 VTODO —— 需到 iPhone 上确认）' : ''),
    );
    if (wrote.reminder.stale) {
      line(`   ${MAYBE} 这个列表在写入前很久没有活动，可能不是 iPhone 提醒事项正在显示的那一个。`);
    }
    line('');
    line(`   ${MAYBE} 最后一步只能你确认：打开 iPhone「提醒事项」，看那条 [probe] 条目是否出现过。`);
    line('      出现过 → 完全打通。没出现 → 该集合其实是日历，改走自建 CalDAV。');
  } else {
    const cands = collections.filter((c) => c.vtodos !== 'no');
    if (cands.length) {
      line(
        `${MAYBE} 提醒事项：${cands.length} 个候选列表，${doWrite ? '试写均被拒' : '尚未试写 → 加 --write 定论'}`,
      );
    } else {
      line(`${NO} 提醒事项：没有集合接受 VTODO（已迁 CloudKit，或账号无 legacy 列表）`);
    }
    if (caldavHome) line(`   分片: ${new URL(caldavHome).host}`);
  }

  // 通讯录
  if (carddavError) {
    line(`${NO} 通讯录：${carddavError.message}`);
  } else if (wrote.contact) {
    line(`${YES} 通讯录：写入已落地 → 通讯录 ${JSON.stringify(wrote.contact.book)}`);
  } else if (books.length) {
    line(
      `${MAYBE} 通讯录：${books.length} 个集合可读（${books.map((b) => b.name).join(', ')}）` +
        (doWrite ? '，但写入失败' : '，加 --write 验证写入'),
    );
  } else {
    line(`${NO} 通讯录：账号没有可写的通讯录集合`);
  }

  const usable =
    Boolean(wrote.reminder || wrote.contact) ||
    (!doWrite && (collections.some((c) => c.vtodos !== 'no') || books.length > 0));

  if (usable) {
    line('');
    line('下一步：把下面的配置填进 ~/.dsh/profiles/desktop/cordis.patch.yml，然后重启 DSH');
    line('');
    line('- insert:');
    line('    - id: apple-write');
    line("      name: 'dsh-apple-write'");
    line('      config:');
    line(`        appleId: '${user ?? '<AppleID>'}'`);
    line("        appPasswordEnv: 'APPLE_ASP'");
    if (wrote.reminder) line(`        reminderList: '${wrote.reminder.list}'`);
    if (wrote.contact) line(`        contactsBook: '${wrote.contact.book}'`);
    line('');
    line('然后跑一次 apple_targets 复核，再让我调 reminder_add / contact_add 写一条真的。');
  } else if (doWrite) {
    line('');
    line('两条通道都没通过。按概率排序的可能原因：');
    line('  1. 口令不是 App 专用密码（用 Apple ID 主密码一定 401/403）');
    line('  2. 账号开了「高级数据保护」（提醒事项端到端加密 → CalDAV 拿不到明文）');
    line('  3. iCloud 里的提醒事项/通讯录开关没开');
    line('  4. 网络层被代理/VPN 拦了（iCloud DAV 在双栈主机上有偶发挂起）');
  }

  line('='.repeat(66));
  process.exitCode = usable ? 0 : 3;
}

main().catch((err) => {
  line('');
  line('='.repeat(66));
  if (err instanceof CalDAVError || err instanceof CardDAVError) {
    bad(`探测中止：${err.message}`);
    if (err.status === 401 || err.status === 403) {
      line('');
      line('这是认证问题，不是协议问题：');
      line('  1. 用 app-specific password（appleid.apple.com → 登录与安全 → App 专用密码）');
      line('  2. 不是 Apple ID 主密码 —— DAV 层没有 2FA 通道');
      line('  3. 改过 Apple ID 密码会让所有 App 专用密码失效，需要重新生成');
    } else if (/timed out|network error/i.test(err.message)) {
      line('');
      line('这是网络问题：强制 IPv4 或 IPv6 二选一，或检查代理/VPN。');
    }
  } else {
    bad(`未预期错误：${err?.stack ?? err}`);
  }
  line('='.repeat(66));
  process.exitCode = 1;
});
