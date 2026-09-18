import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const requestedBundle = process.env.KIRIAN_FROZEN_BRAIN_BUNDLE;

async function waitFor(predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('격리 Brain 검증 대기 시간 초과');
}

function childProcess(executable, directory, configPath, dataDir, args = []) {
  const token = randomBytes(32).toString('hex');
  // 사용자 Python·저장소·provider 환경을 자식에 전달하지 않는다.
  const child = spawn(executable, args, { cwd: directory, windowsHide: true, shell: false,
    env: { SystemRoot: process.env.SystemRoot, PATH: join(process.env.SystemRoot, 'System32'),
      KIRIAN_V1_CONFIG_FILE: configPath, KIRIAN_V1_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
  const exited = once(child, 'exit');
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ token }) + '\n');
  return { child, token, exited, output: () => ({ stdout, stderr }),
    async stop() {
      child.stdin.end();
      try { await waitFor(() => child.exitCode !== null, 10000); }
      finally { if (child.exitCode === null) child.kill(); }
      assert.equal((await exited)[0], 0);
    },
    async ready() {
      await waitFor(() => stdout.includes('\n') || child.exitCode !== null);
      assert.equal(child.exitCode, null, 'frozen Brain 시작 실패: ' + stderr);
      const status = JSON.parse(stdout.trim());
      assert.deepEqual(Object.keys(status).sort(), ['port', 'type']);
      assert.equal(status.type, 'ready');
      assert.ok(Number.isInteger(status.port) && status.port > 0 && status.port < 65536);
      return `http://127.0.0.1:${status.port}`;
    } };
}

test('frozen Brain: Python 없는 경로에서 인증·실제 HTTP/WebSocket·영속성·동일 버전 복구',
  { skip: !requestedBundle, timeout: 60000 }, async () => {
    assert.equal(process.platform, 'win32');
    const source = resolve(requestedBundle);
    await mkdir(join(desktop, '.test-output'), { recursive: true });
    const directory = await mkdtemp(join(desktop, '.test-output/frozen-brain-'));
    const install = join(directory, 'install'), dataDir = join(directory, 'profile/brain');
    const configPath = join(directory, 'host.json'), executable = join(install, 'kirian-brain.exe');
    let calls = 0, current, socket;
    const upstream = createServer(async (request, response) => {
      calls += 1;
      let body = '';
      for await (const chunk of request) body += chunk;
      const value = JSON.parse(body);
      response.setHeader('content-type', 'application/x-ndjson');
      response.end(JSON.stringify({ model: value.model, message: { content: '설치 검증 응답' }, done: true }) + '\n');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const model = { provider_id: 'ollama', model_id: 'frozen-fixture', endpoint_id: 'fixture' };
    try {
      await cp(source, install, { recursive: true });
      const notices = await readFile(join(install, '_internal/licenses/THIRD_PARTY_LICENSES.txt'), 'utf8');
      assert.ok(notices.includes('Python 3.12.') && notices.includes('fastapi 0.135.1'));
      assert.ok(!notices.includes('\0'));
      await writeFile(configPath, JSON.stringify({
        identity: { instance_id: 'frozen-fixture', principal_id: 'owner', mode: 'personal' },
        bindings: [{ model, label: '격리 검증', kind: 'ollama', boundary: 'local',
          url: `http://127.0.0.1:${upstream.address().port}` }],
      }));
      current = childProcess(executable, directory, configPath, dataDir, ['--validate-config']);
      assert.equal((await current.exited)[0], 0);
      assert.deepEqual(current.output(), { stdout: '', stderr: '' });
      await assert.rejects(access(dataDir));
      assert.equal(calls, 0);

      current = childProcess(executable, directory, configPath, dataDir);
      let url = await current.ready();
      const api = async (path, value) => {
        const response = await fetch(url + path, { headers: {
          authorization: `Bearer ${current.token}`, 'content-type': 'application/json',
        }, ...(value === undefined ? {} : { method: 'POST', body: JSON.stringify(value) }), signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200);
        return response.json();
      };
      assert.equal((await fetch(url + '/v1/config', { signal: AbortSignal.timeout(5000) })).status, 401);
      assert.equal((await api('/v1/config')).persistence, true);
      const conversation = (await api('/v1/conversations', {})).conversation;
      const frames = [];
      socket = new WebSocket(url.replace('http:', 'ws:') + '/v1/chat?conversation_id=' + conversation.id,
        { headers: { authorization: `Bearer ${current.token}` } });
      socket.on('message', (message) => frames.push(JSON.parse(String(message))));
      await once(socket, 'open');
      await waitFor(() => frames.some((frame) => frame.kind === 'session.ready'));
      const scope = frames[0].scope;
      const frame = (kind, payload, number) => ({ protocol: 'kirian.rearchitecture.v1', message_id: 'client-' + number,
        request_id: 'request-' + number, scope, kind, turn_id: 'turn-1', intent_id: 'intent-1', sequence: 0, payload });
      socket.send(JSON.stringify(frame('input.finished', { input_id: 'input-1', kind: 'text', text: '설치 검증' }, 1)));
      socket.send(JSON.stringify(frame('turn.start', { selection: { model, source: 'initial_local' }, context: [] }, 2)));
      await waitFor(() => frames.some((item) => item.kind === 'turn.ended'));
      assert.equal(frames.find((item) => item.kind === 'turn.ended').payload.status, 'completed');
      const saved = await api('/v1/conversations/' + conversation.id);
      assert.deepEqual(saved.messages.map((row) => row.text), ['설치 검증', '설치 검증 응답']);
      assert.equal(calls, 1);
      socket.close();
      await once(socket, 'close');
      await current.stop();
      assert.equal(current.output().stderr, '');
      assert.equal(current.output().stdout.trim().split('\n').length, 1);

      // 설치 파일만 손상/교체한다. 제품 데이터 경로는 설치 경로의 외부다.
      await rm(join(install, '_internal/base_library.zip'));
      await cp(source, install, { recursive: true });
      current = childProcess(executable, directory, configPath, dataDir);
      url = await current.ready();
      assert.deepEqual(await api('/v1/conversations/' + conversation.id), saved);
      assert.equal(calls, 1, '복구/재시작은 기존 작업을 자동 재실행하지 않는다');
      await current.stop();

      await writeFile(configPath, '{"secret":"private-fixture"}');
      current = childProcess(executable, directory, configPath, dataDir, ['--validate-config']);
      assert.equal((await current.exited)[0], 1);
      assert.deepEqual(current.output(), { stdout: '', stderr: 'brain_start_failed\r\n' });
      assert.equal(calls, 1);
    } finally {
      socket?.terminate();
      if (current && current.child.exitCode === null) { current.child.kill(); await current.exited; }
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      const checked = resolve(directory);
      assert.ok(checked.startsWith(resolve(desktop, '.test-output') + '\\'));
      await rm(checked, { recursive: true, force: true });
    }
  });
