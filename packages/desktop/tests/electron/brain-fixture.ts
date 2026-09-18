import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagedBrain } from '../../src/main/runtime/managed-brain.js';

export const desktopRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..'
);
export const output = join(desktopRoot, '.test-output');
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
export async function startBrain(
  ollamaUrl: string,
  model: string,
  boundary = 'local',
  hostOptions: Record<string, unknown> = {}
) {
  await mkdir(output, { recursive: true });
  const configPath = join(output, 'brain-' + randomUUID() + '.json');
  const modelRef = {
    provider_id: 'ollama',
    model_id: model,
    endpoint_id: 'test-ollama',
  };
  await writeFile(
    configPath,
    JSON.stringify({
      identity: {
        instance_id: 'desktop-test',
        mode: 'personal',
        principal_id: 'owner',
      },
      bindings: [
        {
          model: modelRef,
          label: model,
          kind: 'ollama',
          url: ollamaUrl,
          boundary,
          think: false,
          num_ctx: 8192,
        },
      ],
      ...hostOptions,
    })
  );
  const frozen = process.env.KIRIAN_TEST_FROZEN_BRAIN;
  if (frozen) {
    if (typeof hostOptions.data_dir !== 'string') throw Error('Frozen fixture requires its isolated data directory');
    const managed = new ManagedBrain({ executable: frozen, dataDirectory: hostOptions.data_dir });
    const connected = await managed.start(configPath);
    return { ...connected, stop: () => managed.stop() };
  }
  const port = await freePort(),
    token = randomBytes(32).toString('hex'),
    url = 'http://127.0.0.1:' + port;
  const python =
    process.env.KIRIAN_PYTHON ??
    join(desktopRoot, '../../.venv/Scripts/python.exe');
  const child = spawn(
    python,
    [
      '-m',
      'uvicorn',
      'rearchitecture.app:create_app',
      '--factory',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--no-access-log',
      '--log-level',
      'warning',
    ],
    {
      cwd: join(desktopRoot, '../brain'),
      env: {
        ...process.env,
        KIRIAN_V1_TOKEN: token,
        KIRIAN_V1_CONFIG_FILE: configPath,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let diagnostic = '';
  child.stderr?.on('data', (data) => {
    diagnostic = (diagnostic + data.toString()).slice(-4000);
  });
  let spawnError: Error | undefined;
  child.on('error', (error) => {
    spawnError = error;
  });
  const stop = async () => {
    if (child.exitCode === null && !child.killed) {
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve())
      );
      child.kill();
      await exited;
    }
  };
  try {
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null)
        throw new Error('Brain exited: ' + diagnostic);
      try {
        const response = await fetch(url + '/v1/config', {
          headers: { Authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(300),
        });
        if (response.ok) {
          await response.body?.cancel();
          return { url, token, stop };
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Brain startup timeout: ' + diagnostic);
  } catch (error) {
    await stop();
    throw error;
  }
}
