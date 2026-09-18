// Exports a squashed public snapshot of the working tree (tracked files only) into a checkout of the public
// portfolio repository. History is never pushed: the private history contains removed third-party assets.
// Excluded: Live2D Core/Framework/sample and Kirian model files, retired GPT-SoVITS runtime inputs, archives,
// experiments, the private plan, caches. The private server address is scrubbed from text files.
// Usage: node tools/public-snapshot/export.mjs --out <public-repo-dir> [--dry-run]
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile, copyFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === '--dry-run') args.set(key, 'true'); else { args.set(key, process.argv[index + 1] ?? ''); index += 1; }
}
const out = args.get('--out');
const dryRun = args.get('--dry-run') === 'true';
if (!out && !dryRun) { console.error('usage: export.mjs --out <public-repo-dir> [--dry-run]'); process.exit(2); }

export const EXCLUDED_PREFIXES = [
  'packages/client/public/live2d/core/', 'packages/client/public/live2d/framework/', 'packages/client/vendor/cubism-framework/',
  'packages/client/public/live2d/kirian/', 'packages/client/model-licenses/kirian-model-provenance.md',
  'packages/web/live2d-samples/',
  'packages/client/src-tauri/',
  'deploy/gpt-sovits/', 'deploy/voice/', 'deploy/systemd/kirian-gpt-sovits-', 'deploy/systemd/kirian-tts-cpufast.service',
  'archive/', 'experiments/', 'tools/agent-orchestrator/', '.cache/', 'CURRENT_PLAN.md', 'AGENTS.md',
];
export const SCRUB = [[/100\.94\.221\.89/g, '<server>'], [/<ssh-key>/g, '<ssh-key>'], [/192\.168\.50\.\d+/g, '<lan-host>']];
const TEXT = /\.(md|mjs|js|ts|tsx|jsx|vue|json|py|sh|service|example|txt|yaml|yml|html|css|toml|cfg|ini)$/;

/** The public notices keep every shipped component but not the private character's production record. */
export function publicNotices(text) {
  const start = text.indexOf('### Kirian character (Live2D model and artwork)');
  const end = text.indexOf('### Live2D Cubism SDK components');
  if (start < 0 || end < 0) return text;
  const replacement = ['### Original character', '', 'The original character under private development, its artwork and its Live2D model are not part of this public snapshot; the public web demo shows a Live2D Inc. sample character (Free Material License, not redistributed here).', '', ''].join(String.fromCharCode(10));
  return text.slice(0, start) + replacement + text.slice(end);
}

export function included(path) {
  return !EXCLUDED_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix));
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
const files = tracked.filter(included);
const excluded = tracked.filter(path => !included(path));
console.log(`tracked ${tracked.length}, exported ${files.length}, excluded ${excluded.length}`);
if (dryRun) { for (const path of excluded) console.log('  - ' + path); process.exit(0); }

const target = resolve(out);
await mkdir(target, { recursive: true });
// Clear only what the public repository tracks; untracked local folders (venvs, caches) in the checkout are left alone.
const trackedInTarget = execFileSync('git', ['ls-files', '-z'], { cwd: target }).toString('utf8').split(String.fromCharCode(0)).filter(Boolean);
for (const path of trackedInTarget) await rm(join(target, path), { force: true });
for (const path of new Set(trackedInTarget.map(path => dirname(path)).filter(path => path !== '.'))) {
  try { if ((await readdir(join(target, path))).length === 0) await rm(join(target, path), { recursive: true }); } catch { /* already gone */ }
}
let scrubbed = 0;
for (const path of files) {
  const source = join(root, path), destination = join(target, path);
  await mkdir(dirname(destination), { recursive: true });
  if (TEXT.test(path) && (await stat(source)).size < 4 * 1024 * 1024) {
    let text = await readFile(source, 'utf8');
    const before = text;
    for (const [pattern, replacement] of SCRUB) text = text.replace(pattern, replacement);
    if (path === 'THIRD_PARTY_NOTICES.md') text = publicNotices(text);
    if (text !== before) scrubbed += 1;
    await writeFile(destination, text);
  } else {
    await copyFile(source, destination);
  }
}
await copyFile(join(root, 'tools/public-snapshot/README.public.md'), join(target, 'README.md'));
console.log(`exported to ${target}; scrubbed ${scrubbed} text files; README replaced with the public one`);
