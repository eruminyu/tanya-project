import { build } from 'esbuild';
import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist-electron/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  define: {
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
  },
  metafile: true,
  legalComments: 'inline',
  logLevel: 'info',
});
// Preserve complete licenses for packages actually bundled into the main process.
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.replaceAll('\\', '/').includes('node_modules/')) continue;
  let directory = dirname(resolve(root, input));
  while (directory !== dirname(directory)) {
    try {
      await access(join(directory, 'package.json'));
      packages.add(directory);
      break;
    } catch {
      directory = dirname(directory);
    }
  }
}
const notices = [];
for (const directory of [...packages].sort()) {
  const pkg = JSON.parse(
    await readFile(join(directory, 'package.json'), 'utf8')
  );
  const names = (await readdir(directory))
    .filter((name) => /^(licen[cs]e|notice)([.-]|$)/i.test(name))
    .sort();
  if (!names.length)
    throw new Error('Missing bundled dependency license: ' + pkg.name);
  notices.push(
    pkg.name +
      '@' +
      pkg.version +
      '\n' +
      (
        await Promise.all(
          names.map((name) => readFile(join(directory, name), 'utf8'))
        )
      ).join('\n')
  );
}
await writeFile(
  join(root, 'dist-electron/THIRD_PARTY_LICENSES.txt'),
  notices.join('\n\n----------------------------------------\n\n') + '\n'
);
