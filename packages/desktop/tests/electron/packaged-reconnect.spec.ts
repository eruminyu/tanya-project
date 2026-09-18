import {test, expect, _electron, type ElectronApplication} from '@playwright/test';
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {output} from './brain-fixture.js';
import {packagedEnvironment, verifyPackagedIdentity} from '../../../../deploy/voice/pc-acceptance/pc/packaged-voice-check.mjs';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const portRefused = (url: string): Promise<boolean> => new Promise(resolve => {
  const socket = createConnection({host: '127.0.0.1', port: Number(new URL(url).port)});
  const finish = (value: boolean) => {socket.destroy(); resolve(value);};
  socket.once('connect', () => finish(false));
  socket.once('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
  socket.setTimeout(500, () => finish(false));
});

test('실제 패키지: 모델 호출 없이 연결 해제·재연결·반복·설정 보존·소유 종료', async () => {
  test.skip(!process.env.KIRIAN_PACKAGED_EXE, '실제 내장 Brain 패키지 경로 필요');
  test.setTimeout(90000);
  const executable = resolve(process.env.KIRIAN_PACKAGED_EXE!);
  await mkdir(output, {recursive: true});
  const root = await mkdtemp(join(output, 'packaged-reconnect-'));
  const profile = join(root, 'profile');
  await mkdir(join(profile, 'runtime'), {recursive: true});
  const hashes: Record<string, string> = {};
  for (const [name, path] of Object.entries({executable,
    app: join(dirname(executable), 'resources/app.asar'),
    brain: join(dirname(executable), 'resources/brain/kirian-brain.exe')})) {
    hashes[name] = sha256(await readFile(path));
  }
  let providerRequests = 0;
  const upstream = createServer((_request, response) => {
    providerRequests++;
    response.writeHead(503); response.end('이 검사는 모델을 호출하지 않습니다.');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${(upstream.address() as {port: number}).port}`;
  const host = {identity: {instance_id: 'personal-v1', mode: 'personal', principal_id: 'owner'},
    bindings: [{model: {provider_id: 'ollama', model_id: 'no-inference-fixture', endpoint_id: 'local'},
      label: '재연결 검사', kind: 'ollama', url: providerUrl, boundary: 'local'}]};
  const settingsPath = join(profile, 'runtime/settings.json');
  await writeFile(settingsPath, JSON.stringify({schemaVersion: 1, host}));
  const settingsHash = sha256(await readFile(settingsPath));
  const evidence: Record<string, any> = {schema: 1, kind: 'packaged-managed-reconnect', executable, hashes,
    profile, cycles: [], passed: false, cleanup: {appClosed: false, brainPortsReleased: false}};
  let app: ElectronApplication | undefined;
  const endpoints = new Set<string>();
  try {
    app = await _electron.launch({executablePath: executable, args: [], cwd: root, chromiumSandbox: true,
      env: packagedEnvironment(process.env, profile)});
    const identity = await app.evaluate(({app}) => ({packaged: app.isPackaged, executable: app.getPath('exe'),
      profile: app.getPath('userData'), pid: process.pid}));
    verifyPackagedIdentity(identity, {executable, profile}); evidence.identity = identity;
    const page = await app.firstWindow();
    await expect(page.getByTestId('connection-status')).toHaveText('연결됨', {timeout: 30000});
    const state = () => page.evaluate(async () => ({runtime: await window.kirianDesktop!.getRuntime(),
      snapshot: await window.kirianDesktop!.getSnapshot()}));
    await expect.poll(async () => (await state()).runtime.phase).toBe('ready');
    const first = await state();
    const conversationId = first.snapshot.library.conversationId;
    expect(conversationId).toBeTruthy();
    endpoints.add(first.snapshot.brain.url);
    await page.getByTestId('brain-settings-toggle').click();
    for (let cycle = 1; cycle <= 2; cycle++) {
      const before = await state();
      const oldUrl = before.snapshot.brain.url;
      await page.getByTestId('brain-disconnect').click();
      await expect.poll(async () => (await state()).runtime.phase).toBe('stopped');
      await expect.poll(async () => (await state()).snapshot.brain.phase).toBe('disconnected');
      await expect.poll(() => portRefused(oldUrl)).toBe(true);
      await page.getByTestId('brain-reconnect').click();
      await expect.poll(async () => {
        const value = await state();
        return [value.runtime.phase, value.snapshot.brain.phase];
      }, {timeout: 12000}).toEqual(['ready', 'ready']);
      const after = await state();
      endpoints.add(after.snapshot.brain.url);
      expect((await fetch(new URL('/v1/config', after.snapshot.brain.url))).status).toBe(401);
      expect(after.snapshot.library.conversationId).toBe(conversationId);
      expect(sha256(await readFile(settingsPath))).toBe(settingsHash);
      expect(providerRequests).toBe(0);
      evidence.cycles.push({cycle, oldUrl, newUrl: after.snapshot.brain.url, oldPortReleased: true,
        ready: true, unauthenticatedStatus: 401, conversationIdPreserved: true, settingsPreserved: true});
    }
    // 이미 연결된 상태의 재연결도 모델 호출이나 설정 변경 없이 완료한다.
    await page.getByTestId('brain-reconnect').click();
    await expect.poll(async () => (await state()).snapshot.brain.phase).toBe('ready');
    const last = await state(); endpoints.add(last.snapshot.brain.url);
    expect(last.snapshot.library.conversationId).toBe(conversationId);
    expect(sha256(await readFile(settingsPath))).toBe(settingsHash);
    expect(providerRequests).toBe(0);
    evidence.connectedReconnect = true; evidence.passed = true;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      await app?.close(); evidence.cleanup.appClosed = Boolean(app);
      await expect.poll(async () => (await Promise.all([...endpoints].map(portRefused))).every(Boolean)).toBe(true);
      evidence.cleanup.brainPortsReleased = endpoints.size > 0;
    } catch (error) {
      evidence.passed = false; evidence.cleanupError = String(error);
      throw error;
    } finally {
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      evidence.providerRequests = providerRequests;
      if (providerRequests !== 0) evidence.passed = false;
      await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2));
      console.log(`재연결 검사 영수증: ${join(root, 'result.json')}`);
      expect(providerRequests).toBe(0);
    }
  }
});
