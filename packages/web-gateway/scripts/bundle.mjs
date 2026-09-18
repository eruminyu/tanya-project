// One self-contained ESM file for the VM: gateway + ws + contracts (ajv) inlined, so the server needs only
// a Node runtime. Bundled package licenses are appended for the release folder.
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'release'), { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'release/gateway.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
  metafile: true,
  legalComments: 'inline',
  logLevel: 'info',
});
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const normalized = input.split('\\').join('/');
  if (!normalized.includes('node_modules/')) continue;
  let directory = dirname(resolve(root, input));
  while (directory !== dirname(directory)) {
    try { await readFile(join(directory, 'package.json')); packages.add(directory); break; } catch { directory = dirname(directory); }
  }
}
let notices = '# Bundled third-party packages\n';
for (const directory of [...packages].sort()) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  let license = '';
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'License']) { try { license = await readFile(join(directory, name), 'utf8'); break; } catch { /* next */ } }
  notices += `\n## ${manifest.name}@${manifest.version} (${manifest.license ?? 'see text'})\n\n${license.trim() || '(license text not shipped in package)'}\n`;
}
// The bundle also carries desktop/src/vendor/airi-audio/tts-chunker.ts (adapted from Project AIRI, MIT) through
// speech-coordinator.ts; that notice is not an npm package, so it is appended and shipped explicitly.
const airi = resolve(root, '../desktop/src/vendor/airi-audio');
notices += `
## Project AIRI audio runtime (MIT) — adapted tts-chunker.ts

${(await readFile(join(airi, 'LICENSE'), 'utf8')).trim()}

Provenance: airi-audio-provenance.json
`;
await writeFile(join(root, 'release', 'THIRD_PARTY_LICENSES.md'), notices);
await copyFile(join(airi, 'LICENSE'), join(root, 'release', 'airi-audio-MIT.txt'));
await copyFile(join(airi, 'provenance.json'), join(root, 'release', 'airi-audio-provenance.json'));
console.log(`Bundled gateway with ${packages.size} packages.`);
