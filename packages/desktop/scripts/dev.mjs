import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const tsc = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url)
);
function runNode(args, cwd = root) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
    });
    p.once('error', reject);
    p.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Build failed: ' + code))
    );
  });
}
await runNode(
  ['scripts/generate.mjs'],
  fileURLToPath(new URL('../../contracts/', import.meta.url))
);
await runNode(
  [tsc, '-p', 'tsconfig.json'],
  fileURLToPath(new URL('../../contracts/', import.meta.url))
);
await runNode([tsc, '-p', 'tsconfig.electron.json']);
await runNode(['scripts/bundle.mjs']);
const server = await createServer({ root });
await server.listen();
const env = { ...process.env, KIRIAN_RENDERER_URL: 'http://127.0.0.1:5178/' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
});
async function close() {
  if (!child.killed) child.kill();
  await server.close();
}
child.once('exit', async (code) => {
  await server.close();
  process.exitCode = code ?? 1;
});
child.once('error', async (error) => {
  console.error(error);
  await server.close();
  process.exitCode = 1;
});
process.once('SIGINT', close);
process.once('SIGTERM', close);
