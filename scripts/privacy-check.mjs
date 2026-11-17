#!/usr/bin/env node
/**
 * 发布前隐私闸门：扫描 **实际会进 npm 包的文件**，确认没有个人信息随包发出。
 *
 * 检查对象来自 `npm pack --dry-run --json` 的清单，不是猜的目录 —— 只有真正打进
 * tarball 的东西才算数。
 *
 * 三类检查：
 *   1. 固定模式：真实邮箱域、本机绝对路径、iCloud 分片主机、大陆手机号、App 专用密码形状
 *   2. 账号指纹：当前 git 的 user.name / user.email、系统用户名（**不写死在仓库里**，
 *      否则这个脚本本身就成了泄露源）
 *   3. 白名单：测试夹具里故意用的假值，命中也放过
 *
 * 用法：node scripts/privacy-check.mjs   （命中 → 退出码 1）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** Test fixtures that are deliberately fake — keep this list tiny and obvious. */
const ALLOW = [
  'xxxx-xxxx-xxxx-xxxx',
  'abcd-efgh-ijkl-mnop',
  'aaaa-bbbb-cccc-dddd',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'you@example.com',
  'ops@example.com',
  'z@x.com',
  'probe@example.com',
  '+8613800138000',
  '+8613900139000',
  '+8613700137000',
  '+861012345678',
  'p42-caldav.icloud.com',
  'p62-caldav.icloud.com',
  'p62-contacts.icloud.com',
  'p42-contacts.icloud.com',
];

const fixed = [
  { name: '真实邮箱域', re: /[\w.%+-]+@(?:qq|gmail|outlook|hotmail|163|126|foxmail|icloud)\.com/gi },
  {
    name: '本机绝对路径',
    // 只认真实家目录形态：C:\Users\<name>、/Users/<name>/、/home/<name>/<x>
    // （CalDAV 夹具里的 /home/xxx.ics 是集合路径，不是家目录）
    re: /(?:[A-Za-z]:\\\\Users\\\\[^\\\s<>"']+|\/Users\/[^/\s<>"']+\/|\/home\/[^/\s<>"']+\/[^/\s<>"']+)/g,
  },
  { name: 'iCloud 真实分片主机', re: /\bp\d{2,4}-(?:caldav|contacts)\.icloud\.com(?:\.cn)?\b/gi },
  { name: '大陆手机号', re: /\b1[3-9]\d{9}\b/g },
  { name: 'App 专用密码形状', re: /\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/gi },
  { name: 'GitHub token 形状', re: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

// 账号指纹：运行时从本机取，绝不写进仓库。
function accountPatterns() {
  const out = [];
  // 仓库 owner 是公开身份（就写在 package.json 的 repository 里），不算泄露。
  let publicOwner = '';
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const url = pkg.repository?.url ?? pkg.repository ?? '';
    const m = /github\.com[/:]([^/]+)\//.exec(String(url));
    if (m) publicOwner = m[1].toLowerCase();
  } catch {}
  ALLOW.push(...(publicOwner ? [publicOwner] : []));
  if (publicOwner) out.push({ name: 'package.json repository owner', re: /$^/ }); // no-op, documented below
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8' }).trim();
    if (name && name.length >= 3 && name.toLowerCase() !== publicOwner) {
      out.push({ name: 'git user.name', re: new RegExp(escape(name), 'gi') });
    }
  } catch {}
  try {
    const email = execFileSync('git', ['config', 'user.email'], { cwd: root, encoding: 'utf8' }).trim();
    // GitHub 的 noreply 地址本来就是给人看的，不算泄露
    if (email && email.length >= 5 && !/@users\.noreply\.github\.com$/i.test(email)) {
      out.push({ name: 'git user.email', re: new RegExp(escape(email), 'gi') });
    }
  } catch {}
  if (process.env.USERNAME && process.env.USERNAME.length >= 4) {
    out.push({ name: '系统用户名', re: new RegExp(`\\b${escape(process.env.USERNAME)}\\b`, 'gi') });
  }
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function shippedFiles() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return entry.files.map((f) => f.path).filter((p) => !/\.(?:png|jpg|jpeg|gif|tgz)$/i.test(p));
}

const patterns = [...fixed, ...accountPatterns()];
const files = shippedFiles();
const hits = [];

for (const rel of files) {
  let text;
  try {
    text = readFileSync(resolve(root, rel), 'utf8');
  } catch {
    continue;
  }
  for (const { name, re } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (ALLOW.some((a) => value.toLowerCase() === a.toLowerCase() || value.includes(a))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ file: rel, line, pattern: name, value });
    }
  }
}

console.log(`扫描 ${files.length} 个待发布文件，${patterns.length} 条规则：`);
for (const p of patterns) console.log(`  - ${p.name}`);

if (hits.length === 0) {
  console.log('\n✓ 未发现个人信息');
  process.exit(0);
}

console.log(`\n✗ 发现 ${hits.length} 处可疑内容：`);
for (const h of hits) console.log(`  ${h.file}:${h.line}  [${h.pattern}]  ${JSON.stringify(h.value)}`);
process.exit(1);
