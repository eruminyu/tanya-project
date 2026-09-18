// Assembles a web-demo release folder from built artifacts: the bundled gateway, the web build, the Brain
// source package with its pinned requirements, the contracts Python package and the deploy files.
// Usage: node deploy/web/prepare_release.mjs [output-dir]
import { cp, mkdir, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const output = resolve(process.argv[2] ?? join(root, '.cache', `web-release-${stamp}`));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// The web build ships exactly one character (profile kirian: live2d/kirian, profile tanya: live2d/hiyori).
const required = ['packages/web-gateway/release/gateway.mjs', 'packages/web/dist/index.html', 'packages/web/dist/live2d/core', 'packages/web/dist/notices.html'];
for (const path of required) { try { await stat(join(root, path)); } catch { throw new Error('build first: missing ' + path); } }

await cp(join(root, 'packages/web-gateway/release'), join(output, 'gateway'), { recursive: true });
await cp(join(root, 'packages/web/dist'), join(output, 'web'), { recursive: true });
await mkdir(join(output, 'brain'), { recursive: true });
await cp(join(root, 'packages/brain/rearchitecture'), join(output, 'brain/rearchitecture'), { recursive: true,
  filter: source => !source.includes('__pycache__') });
await cp(join(root, 'packages/brain/requirements-v1.txt'), join(output, 'brain/requirements-v1.txt'));
// rearchitecture/audio.py imports the shared TTS text preprocessor from the legacy `core` package.
await mkdir(join(output, 'brain/core'), { recursive: true });
await writeFile(join(output, 'brain/core/__init__.py'), '');
await cp(join(root, 'packages/brain/core/tts_text_preprocessor.py'), join(output, 'brain/core/tts_text_preprocessor.py'));
await mkdir(join(output, 'contracts'), { recursive: true });
for (const name of ['pyproject.toml', 'python', 'schema']) await cp(join(root, 'packages/contracts', name), join(output, 'contracts', name), { recursive: true, filter: source => !source.includes('__pycache__') });
await cp(join(root, 'deploy/web'), join(output, 'deploy'), { recursive: true, filter: source => !source.endsWith('prepare_release.mjs') });

// The voice service is Qwen3-TTS with the preset speaker (deploy/qwen3-tts); public-host.json needs no
// recorded reference audio, so nothing is filled from a private host file any more.
await cp(join(root, 'deploy/qwen3-tts'), join(output, 'deploy/qwen3-tts'), { recursive: true, filter: source => !source.includes('__pycache__') });

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path)); else files.push(path);
  }
  return files;
}
const lines = [];
for (const file of (await walk(output)).sort()) {
  const relativePath = relative(output, file).split('\\').join('/');
  if (relativePath === 'SHA256SUMS') continue;
  lines.push(`${createHash('sha256').update(await readFile(file)).digest('hex')}  ${relativePath}`);
}
await writeFile(join(output, 'SHA256SUMS'), lines.join('\n') + '\n');
console.log(`release prepared: ${output} (${lines.length} files)`);
