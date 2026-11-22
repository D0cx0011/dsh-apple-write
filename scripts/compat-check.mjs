#!/usr/bin/env node
/**
 * Does this plugin still load on the DSH that is installed right now?
 *
 * A DSH upgrade can change @deepseek-ai/dsh-tools without changing anything this
 * package declares, so listening to semver is not enough — the only honest check
 * is to run apply() against the *shipped* tool registry and see whether all tools
 * register. The packages live inside app.asar, so this unpacks the ones we need
 * into a temp dir, copies lib/ next to them, and imports through that tree.
 *
 *   node scripts/compat-check.mjs                 # auto-detect the install
 *   node scripts/compat-check.mjs --asar <path>   # explicit app.asar
 *   node scripts/compat-check.mjs --keep          # keep the temp dir for debugging
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

function findAsar() {
  const explicit = arg('asar');
  if (explicit) return path.resolve(explicit);
  const candidates = [
    process.env.DSH_ASAR,
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
    path.join(process.env.HOME ?? '', '.local/share/deepseek-harness/resources/app.asar'),
  ].filter(Boolean);
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

/** Read the asar index: offset -> file entries. */
function readIndex(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  const json = Buffer.alloc(jsonSize);
  fs.readSync(fd, json, 0, jsonSize, 16);
  const tree = JSON.parse(json.toString('utf8'));
  const files = new Map();
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const full = `${prefix}/${name}`;
      if (value.files) walk(value, full);
      else files.set(full, value);
    }
  };
  walk(tree, '');
  return { fd, files, dataStart: 8 + headerSize };
}

const ONLY = /\.(js|mjs|cjs|json)$/;

function extract(asarPath, outRoot) {
  const { fd, files, dataStart } = readIndex(asarPath);
  const unpackedRoot = `${asarPath}.unpacked`;
  let written = 0;
  const versions = new Map();
  for (const [key, meta] of files) {
    const m = /(?:^|\/)node_modules\/(@deepseek-ai\/[^/]+)\/(.*)$/.exec(key);
    if (!m) continue;
    const [, pkg, rest] = m;
    if (!ONLY.test(rest)) continue;
    if (rest !== 'package.json' && !rest.startsWith('lib/') && !rest.startsWith('dist/')) continue;
    // Directory entries carry no payload; packed files carry offset+size, and
    // `unpacked` ones live beside the archive instead.
    const size = Number(meta.size);
    const offset = Number(meta.offset);
    if (Number.isNaN(size) || Number.isNaN(offset)) continue;
    let buf;
    if (meta.unpacked) {
      const onDisk = path.join(unpackedRoot, key.replace(/^\//, ''));
      if (!fs.existsSync(onDisk)) continue;
      buf = fs.readFileSync(onDisk);
    } else {
      buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, dataStart + offset);
    }
    const dst = path.join(outRoot, 'node_modules', pkg, rest);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
    written += 1;
    if (rest === 'package.json') {
      try {
        versions.set(pkg, JSON.parse(buf.toString('utf8')).version);
      } catch {
        /* a malformed manifest is not worth failing the run over */
      }
    }
  }
  fs.closeSync(fd);
  return { written, versions };
}

const asarPath = findAsar();
if (!asarPath) {
  console.error('找不到 app.asar。用 --asar 指定，或设 DSH_ASAR 环境变量。');
  process.exit(2);
}
console.log(`asar: ${asarPath}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-'));
try {
  const { written, versions } = extract(asarPath, tmp);
  console.log(`解出 ${written} 个包文件，${versions.size} 个 @deepseek-ai 包`);

  const tools = versions.get('@deepseek-ai/dsh-tools');
  const schema = versions.get('@deepseek-ai/schemastery');
  console.log(`dsh-tools: ${tools ?? '(未知)'}   schemastery: ${schema ?? '(未知)'}`);

  // The plugin resolves bare imports by walking up from its own directory, so a
  // copy placed inside the temp tree picks up the extracted packages.
  const pluginDir = path.join(tmp, 'plugin');
  fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true });
  for (const file of fs.readdirSync(path.join(ROOT, 'lib'))) {
    if (file.endsWith('.js')) fs.copyFileSync(path.join(ROOT, 'lib', file), path.join(pluginDir, 'lib', file));
  }
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(
    path.join(tmp, 'run.mjs'),
    `import { apply, name, Config } from './plugin/lib/index.js';
const registered = [];
const ctx = { tools: { register: (d) => registered.push(d) }, logger: { warn() {}, info() {} } };
apply(ctx, { appleId: 'compat@example.com', appPassword: 'abcd-efgh-ijkl-mnop' });
console.log(JSON.stringify({ plugin: name, hasConfig: Boolean(Config), tools: registered.map((t) => t.name) }));
`,
  );

  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [path.join(tmp, 'run.mjs')], { cwd: tmp, encoding: 'utf8' });
  const result = JSON.parse(out.trim().split('\n').pop());
  const expected = 12;
  if (!result.hasConfig) throw new Error('Config schema did not load');
  if (result.tools.length < expected) {
    throw new Error(`只注册了 ${result.tools.length} 个工具（应 ≥ ${expected}）：${result.tools.join(', ')}`);
  }
  console.log(`✓ 在 dsh-tools ${tools ?? '(未知版本)'} 上成功注册 ${result.tools.length} 个工具：`);
  console.log(`  ${result.tools.join(', ')}`);
  console.log('\n兼容。若 DSH 再升级，重跑这条命令即可。');
} catch (err) {
  console.error('\n✗ 兼容检查失败：', err?.message ?? err);
  console.error('  插件可能需要针对新的 @deepseek-ai/dsh-tools 调整 defineTool 用法或 output 声明。');
  process.exitCode = 1;
} finally {
  if (flag('keep')) console.error(`临时目录保留：${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
}
