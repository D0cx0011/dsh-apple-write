#!/usr/bin/env node
/**
 * 真机验收：拿**已安装的那份产物**跑一遍真实 iCloud。
 *
 *   $env:APPLE_ID  = 'you@example.com'
 *   $env:APPLE_ASP = 'xxxx-xxxx-xxxx-xxxx'
 *   node scripts/acceptance.mjs            # 只读：两次发现 + 列表诊断
 *   node scripts/acceptance.mjs --write    # 再加一条真实往返：写 → 回读 → 删
 *
 * 默认测 `dsh --profile probe add github:<owner>/dsh-apple-write` 装好的那份，
 * 用 `--lib <file url>` 指向别的副本。写模式会在你的提醒清单里创建一条
 * `[acceptance] …` 并立刻删掉；中途失败不会自动删，脚本会把 uid 打出来。
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const libArg = args.indexOf('--lib');
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '';

function resolveLib() {
  if (libArg >= 0) return pathToFileURL(resolve(args[libArg + 1])).href;
  // 默认：装进 probe profile 的那份（跨平台拼路径）
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    void root;
  } catch {}
  const candidates = [
    `${HOME}/.dsh/profiles/probe/node_modules/dsh-apple-write/lib/index.js`,
    `${HOME}/.dsh/profiles/desktop/node_modules/dsh-apple-write/lib/index.js`,
  ];
  return pathToFileURL(candidates[0]).href;
}

const LIB = resolveLib();
const appleId = process.env.APPLE_ID;
const passwordEnv = 'APPLE_ASP';
if (!appleId) {
  console.error('缺少 APPLE_ID 环境变量（账号邮箱）。');
  process.exit(2);
}
if (!process.env[passwordEnv]) {
  console.error(`缺少 ${passwordEnv} 环境变量（App 专用密码）。`);
  process.exit(2);
}

console.log('module under test:', LIB);
console.log('mode:', WRITE ? 'read + write/delete round trip' : 'read only');

const { apply } = await import(LIB);
const tools = new Map();
apply(
  { tools: { register: (t) => tools.set(t.name, t) }, logger: { warn: (m) => console.log('[warn]', m) } },
  { appleId, appPasswordEnv: passwordEnv, reminderList: process.env.APPLE_REMINDER_LIST || 'Reminders', timeoutMs: 25000 },
);

const show = (title, blocks) => {
  console.log('\n=== ' + title + ' ===');
  for (const b of blocks) console.log(b.text);
};
const run = async (name, params, exec = {}) => tools.get(name).execute(params, exec);

let created = null;
const checks = [];
try {
  const targets = await run('apple_targets', {});
  show('apple_targets', tools.get('apple_targets').output.render({}, targets));
  checks.push(['两个通道都可读', targets.reminders?.ok === true && targets.contacts?.ok === true]);

  const lists = await run('reminder_lists', {});
  show('reminder_lists', tools.get('reminder_lists').output.render({}, lists));
  checks.push(['至少一个列表声明 VTODO', lists.reachable === true]);

  if (WRITE) {
    const title = '[acceptance] 验收条目 ' + new Date().toISOString().slice(11, 19);
    created = await run('reminder_add', { title, due: '2026-12-31', alarm: '1h', priority: 5 });
    show('reminder_add', tools.get('reminder_add').output.render({}, created));

    const read = await run('reminder_list_items', { query: '[acceptance]' });
    show('reminder_list_items', tools.get('reminder_list_items').output.render({}, read));
    checks.push(['写入后可回读', read.matched >= 1]);

    const removed = await run('reminder_remove', { uid: created.uid });
    show('reminder_remove', tools.get('reminder_remove').output.render({}, removed));
    created = null;

    const after = await run('reminder_list_items', { query: '[acceptance]' });
    show('回读确认（应为 0）', tools.get('reminder_list_items').output.render({}, after));
    checks.push(['删除后不再出现', after.matched === 0]);
  }
} catch (err) {
  console.error('\n验收中断：', err?.message ?? err);
  if (created?.uid) console.error(`⚠ 已在提醒事项里留下一条 uid=${created.uid}，请手动删除。`);
  process.exit(1);
}

console.log('\n--- 结论 ---');
let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass) ok = false;
}
console.log(ok ? '\n验收：PASS' : '\n验收：FAIL');
process.exit(ok ? 0 : 1);
