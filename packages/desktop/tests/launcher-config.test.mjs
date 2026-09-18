import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, access, unlink, rmdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { launchLocal, parseOptions, prepareHostConfig, resolveDataDirectory, usage } from '../scripts/start-local.mjs';

function hostConfig() {
  const model = { provider_id: 'ollama', model_id: 'test-model', endpoint_id: 'owner-llm' };
  return {
    identity: { instance_id: 'launcher-fixture', mode: 'personal', principal_id: 'owner' },
    bindings: [{ model, label: 'Fixture LLM', kind: 'ollama', url: 'http://127.0.0.1:11434', boundary: 'local', think: false, num_ctx: 8192 }],
    saved_default: { ...model },
    speech: {
      model: { provider_id: 'qwen3-tts', model_id: 'preset-voice', endpoint_id: 'owner-tts' },
      label: 'Preset voice fixture', url: 'http://127.0.0.1:19882/tts', boundary: 'private_lan',
      language: 'Korean', speaker: 'Sohee', instruct: '', seed: 12, timeout_seconds: 90,
    },
    transcription: { url: 'http://127.0.0.1:8098/stt/transcriptions', boundary: 'local', model_label: 'Existing STT', timeout_seconds: 60 },
  };
}

async function fixture(t, source = hostConfig()) {
  const directory = await mkdtemp(join(tmpdir(), 'kirian-launcher-test-'));
  const configPath = join(directory, 'source.json');
  await writeFile(configPath, JSON.stringify(source));
  t.after(async () => { await unlink(configPath); await rmdir(directory); });
  return configPath;
}

function runtime(overrides = {}) {
  const calls = [], logs = [], errors = [], probes = [], requests = [];
  let nextPort = 20000;
  const dependencies = {
    allocatePort: async () => nextPort++,
    probeForward: async (port) => { probes.push(port); return true; },
    pause: async () => {},
    request: async (url, options) => { requests.push({ url, options }); return { ok: true, body: { cancel: async () => {} } }; },
    log: (message) => logs.push(message), reportError: (message) => errors.push(message),
    spawnProcess(command, args, options) {
      const child = new EventEmitter();
      child.exitCode = null; child.killed = false; child.killCount = 0;
      child.kill = () => {
        child.killed = true; child.killCount++;
        queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); });
        return true;
      };
      const call = { command, args, options, child };
      if (args.includes('uvicorn')) {
        call.configPath = options.env.KIRIAN_V1_CONFIG_FILE;
        call.config = JSON.parse(readFileSync(call.configPath, 'utf8'));
      }
      calls.push(call);
      return child;
    },
    ...overrides,
    environment: { KIRIAN_PYTHON: process.execPath, KIRIAN_DESKTOP_TEST: '1',
      KIRIAN_TEST_PROFILE: join(tmpdir(), 'kirian-launcher-fixture-profile'), ...overrides.environment },
  };
  return { dependencies, calls, logs, errors, probes, requests };
}

test('config and environment precedence are explicit; model/config conflicts and incomplete options fail', () => {
  assert.equal(parseOptions(['--config', 'explicit.json'], { KIRIAN_V1_CONFIG_FILE: 'env.json' }).configFile, 'explicit.json');
  assert.equal(parseOptions([], { KIRIAN_V1_CONFIG_FILE: 'env.json' }).configFile, 'env.json');
  assert.equal(parseOptions(['--ssh', 'owner@host', '--identity', 'key', '--model', 'chosen'], {}).model, 'chosen');
  for (const args of [['--config'], ['--identity', 'key'], ['--config', '--ssh'], ['--config', 'a', '--config', 'b'], ['--ssh', '-oProxyCommand=bad', '--identity', 'key']])
    assert.throws(() => parseOptions(args, {}));
  assert.throws(() => parseOptions(['--config', 'a', '--model', 'other'], {}), /cannot override/);
  assert.throws(() => parseOptions(['--model', 'other'], { KIRIAN_V1_CONFIG_FILE: 'env.json' }), /cannot override/);
  assert.match(usage, /8098\/stt\/transcriptions/);
});

test('SSH rewrites all service URLs, records the LAN boundary, and preserves model and voice configuration', async () => {
  const original = hostConfig(), before = structuredClone(original);
  let port = 24000;
  const { config, forwards } = await prepareHostConfig(original, { ssh: true, allocatePort: async () => port++ });
  assert.deepEqual(original, before);
  assert.deepEqual(forwards.map((forward) => forward.remotePort), [11434, 19882, 8098]);
  assert.deepEqual(forwards.map((forward) => forward.localPort), [24000, 24001, 24002]);
  assert.equal(config.bindings[0].url, 'http://127.0.0.1:24000/');
  assert.equal(config.speech.url, 'http://127.0.0.1:24001/tts');
  assert.equal(config.transcription.url, 'http://127.0.0.1:24002/stt/transcriptions');
  for (const item of [...config.bindings, config.speech, config.transcription]) assert.equal(item.boundary, 'private_lan');
  config.bindings[0].url = original.bindings[0].url;
  config.bindings[0].boundary = original.bindings[0].boundary;
  config.speech.url = original.speech.url;
  config.transcription.url = original.transcription.url;
  config.transcription.boundary = original.transcription.boundary;
  assert.deepEqual(config, original);
});

test('shared remote endpoints share a tunnel and retry duplicate local ports; IPv6 targets remain distinct', async () => {
  const original = hostConfig();
  original.bindings.push({ ...original.bindings[0], model: { ...original.bindings[0].model, model_id: 'second' }, url: 'http://127.0.0.1:11434/other' });
  original.transcription.url = 'http://[::1]:8098/stt';
  const ports = [25000, 25000, 25001, 25002];
  const { config, forwards } = await prepareHostConfig(original, { ssh: true, allocatePort: async () => ports.shift() });
  assert.equal(forwards.length, 3);
  assert.equal(new URL(config.bindings[1].url).port, '25000');
  assert.deepEqual(forwards[2], { localPort: 25002, remoteHost: '[::1]', remotePort: 8098 });
  assert.equal(new URL(config.transcription.url).hostname, '[::1]');
});

test('direct explicit endpoints stay unchanged and cloud boundaries are never downgraded by SSH', async () => {
  const original = hostConfig();
  original.bindings.push({ ...original.bindings[0], url: 'https://provider.example/v1', boundary: 'cloud', api_key_env: 'FIXTURE_API_KEY' });
  original.transcription.url = 'http://192.168.1.3:8098/stt';
  original.transcription.boundary = 'private_lan';
  const direct = await prepareHostConfig(original);
  assert.deepEqual(direct.config, original);
  assert.deepEqual(direct.forwards, []);
  let port = 26000;
  const tunnelled = await prepareHostConfig(original, { ssh: true, allocatePort: async () => port++ });
  assert.deepEqual(tunnelled.config.bindings[1], original.bindings[1]);
  assert.deepEqual(tunnelled.config.transcription, original.transcription);
  original.bindings[1].url = 'https://localhost:443/v1';
  const cloudTunnel = await prepareHostConfig(original, { ssh: true, allocatePort: async () => port++ });
  assert.equal(cloudTunnel.config.bindings[1].boundary, 'cloud');
  assert.equal(new URL(cloudTunnel.config.bindings[1].url).hostname, 'localhost');
});

test('unsafe or mislabeled URLs and inline credentials fail before any port allocation', async () => {
  const cases = [
    { url: 'http://provider.example', boundary: 'local' },
    { url: 'http://8.8.8.8', boundary: 'private_lan' },
    { url: 'http://provider.example', boundary: 'private_lan' },
    { url: 'http://10.invalid.private.example', boundary: 'private_lan' },
    { url: 'http://provider.example', boundary: 'cloud' },
    { url: 'file:///tmp/service', boundary: 'local' },
    { url: 'http://name:secret@127.0.0.1:9881', boundary: 'local' },
    { url: 'http://127.0.0.1:9881/?secret=value', boundary: 'local' },
    { url: 'http://127.0.0.1:9881/#fragment', boundary: 'local' },
    { url: 'http://127.0.0.1:0', boundary: 'local' },
    { url: 'http://127.0.0.1:9881', boundary: 'unknown' },
    { url: 'https://provider.example', boundary: 'cloud', api_key: 'forbidden-fixture' },
  ];
  for (const invalid of cases) {
    const original = hostConfig();
    Object.assign(original.bindings[0], invalid);
    let allocations = 0;
    await assert.rejects(prepareHostConfig(original, { ssh: true, allocatePort: async () => { allocations++; return 26000; } }));
    assert.equal(allocations, 0);
  }
});

test('launcher spawns one SSH with all forwards and Python/Electron with environment-only token, then cleans owned resources', async (t) => {
  const configFile = await fixture(t), source = await readFile(configFile, 'utf8');
  const run = runtime();
  const launcher = await launchLocal(['--config', configFile, '--ssh', 'owner@host', '--identity', process.execPath], run.dependencies);
  t.after(() => launcher.stop());
  const [ssh, brain, app] = run.calls;
  assert.equal(run.calls.length, 3);
  assert.equal(ssh.command, 'ssh');
  assert.deepEqual(ssh.args.filter((_, i) => ssh.args[i - 1] === '-L'), [
    '127.0.0.1:20000:127.0.0.1:11434', '127.0.0.1:20001:127.0.0.1:19882', '127.0.0.1:20002:127.0.0.1:8098',
  ]);
  assert.deepEqual(run.probes, [20000, 20001, 20002]);
  assert.ok(brain.configPath !== configFile);
  assert.equal(brain.config.speech.speaker, hostConfig().speech.speaker);
  assert.equal(brain.config.transcription.boundary, 'private_lan');
  const token = brain.options.env.KIRIAN_V1_TOKEN;
  assert.equal(token.length, 64);
  assert.equal(app.options.env.KIRIAN_BRAIN_TOKEN, token);
  assert.equal(app.options.env.KIRIAN_V1_TOKEN, undefined);
  for (const call of run.calls) {
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.args.some((value) => value.includes(token)), false);
  }
  assert.equal(JSON.stringify(brain.config).includes(token), false);
  assert.equal([...run.logs, ...run.errors].some((value) => value.includes(token)), false);
  assert.match(run.logs[0], /actual host boundary: private_lan/);
  assert.equal(run.requests.length, 1); // No health GET that could invoke a TTS/STT action.
  assert.match(run.requests[0].url, /\/v1\/config$/);
  app.child.exitCode = 0;
  app.child.emit('exit', 0);
  assert.equal(await launcher.done, 0);
  assert.equal(ssh.child.killCount, 1);
  assert.equal(brain.child.killCount, 1);
  assert.equal(app.child.killCount, 0);
  await assert.rejects(access(brain.configPath), { code: 'ENOENT' });
  await assert.rejects(access(dirname(brain.configPath)), { code: 'ENOENT' });
  assert.equal(await readFile(configFile, 'utf8'), source);
  await launcher.stop();
  assert.equal(ssh.child.killCount, 1);
});

test('Brain startup failure kills owned SSH and Python and removes temporary config without spawning Electron', async (t) => {
  const configFile = await fixture(t);
  const run = runtime({ request: async () => ({ ok: false, body: { cancel: async () => {} } }) });
  await assert.rejects(launchLocal(['--config', configFile, '--ssh', 'owner@host', '--identity', process.execPath], run.dependencies), /Brain startup unavailable/);
  assert.equal(run.calls.length, 2);
  for (const call of run.calls) assert.equal(call.child.killCount, 1);
  await assert.rejects(access(run.calls[1].configPath), { code: 'ENOENT' });
  await assert.rejects(access(dirname(run.calls[1].configPath)), { code: 'ENOENT' });
  await access(configFile);
});

test('SSH exit while Brain is starting prevents a late successful health response from launching Electron', async (t) => {
  const configFile = await fixture(t);
  const run = runtime();
  run.dependencies.request = async () => {
    run.calls[0].child.exitCode = 255;
    run.calls[0].child.emit('exit', 255);
    return { ok: true, body: { cancel: async () => {} } };
  };
  await assert.rejects(launchLocal(['--config', configFile, '--ssh', 'owner@host', '--identity', process.execPath], run.dependencies), /Startup cancelled/);
  assert.equal(run.calls.length, 2);
  assert.equal(run.calls[1].child.killCount, 1);
  await assert.rejects(access(run.calls[1].configPath), { code: 'ENOENT' });
});

test('existing --ssh --model and environment host-config usage remain supported', async (t) => {
  const legacy = runtime();
  const first = await launchLocal(['--ssh', 'owner@host', '--identity', process.execPath, '--model', 'chosen-fixture'], legacy.dependencies);
  t.after(() => first.stop());
  assert.equal(legacy.calls[1].config.bindings[0].model.model_id, 'chosen-fixture');
  assert.equal(legacy.calls[1].config.bindings[0].boundary, 'private_lan');
  assert.equal(legacy.calls[0].args.filter((value) => value === '-L').length, 1);
  await first.stop();
  const configFile = await fixture(t);
  const explicit = runtime({ environment: { KIRIAN_PYTHON: process.execPath, KIRIAN_V1_CONFIG_FILE: configFile } });
  const second = await launchLocal([], explicit.dependencies);
  t.after(() => second.stop());
  assert.equal(explicit.calls.length, 2);
  assert.deepEqual(explicit.calls[0].config, { ...hostConfig(), data_dir: join(explicit.dependencies.environment.KIRIAN_TEST_PROFILE, 'brain') });
  assert.deepEqual(explicit.probes, []);
  await second.stop();
});

test('implicit remote URL still requires explicit host config and never starts a process', async () => {
  const run = runtime({ environment: { KIRIAN_PYTHON: process.execPath, KIRIAN_V1_OLLAMA_URL: 'http://192.168.1.4:11434' } });
  await assert.rejects(launchLocal([], run.dependencies), /declare the actual remote boundary/);
  assert.deepEqual(run.calls, []);
});

test('data directory precedence preserves explicit paths and isolates test defaults', () => {
  const source = hostConfig();
  source.data_dir = './explicit-host-data';
  assert.equal(resolveDataDirectory(source, { KIRIAN_V1_DATA_DIR: './explicit-env-data' }), './explicit-env-data');
  assert.equal(resolveDataDirectory(source, { KIRIAN_DESKTOP_TEST: '1' }), './explicit-host-data');
  assert.equal(resolveDataDirectory(hostConfig(), { KIRIAN_DESKTOP_TEST: '1', KIRIAN_TEST_PROFILE: '/fixture/profile', APPDATA: '/must-not-use' }), join('/fixture/profile', 'brain'));
  assert.equal(resolveDataDirectory(hostConfig(), { APPDATA: '/fixture/appdata' }), join('/fixture/appdata', 'Kirian Development', 'brain'));
  assert.equal(resolveDataDirectory(hostConfig(), {}), join(homedir(), '.kirian', 'brain'));
  assert.throws(() => resolveDataDirectory(hostConfig(), { KIRIAN_DESKTOP_TEST: '1', APPDATA: '/must-not-use' }), /requires KIRIAN_TEST_PROFILE/);
  assert.throws(() => resolveDataDirectory(source, { KIRIAN_V1_DATA_DIR: '' }), /non-empty path/);
});

test('host data_dir survives SSH rewriting while invalid directory values fail validation', async () => {
  const source = { ...hostConfig(), data_dir: './existing host data' };
  let port = 28000;
  const prepared = await prepareHostConfig(source, { ssh: true, allocatePort: async () => port++ });
  assert.equal(prepared.config.data_dir, source.data_dir);
  assert.equal(source.bindings[0].url, 'http://127.0.0.1:11434');
  for (const value of [false, 12, '', '   ', 'bad\0path', 'x'.repeat(4097)])
    await assert.rejects(prepareHostConfig({ ...hostConfig(), data_dir: value }), /non-empty path/);
});

test('restarting the launcher reuses a stable default data path outside each temporary host config', async (t) => {
  const configFile = await fixture(t);
  const environment = { KIRIAN_DESKTOP_TEST: '0', APPDATA: join(dirname(configFile), 'fixture-appdata') };
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const run = runtime({ environment });
    const launcher = await launchLocal(['--config', configFile], run.dependencies);
    t.after(() => launcher.stop());
    runs.push(run.calls[0]);
    await launcher.stop();
    await assert.rejects(access(run.calls[0].configPath), { code: 'ENOENT' });
  }
  const expected = join(environment.APPDATA, 'Kirian Development', 'brain');
  assert.notEqual(runs[0].configPath, runs[1].configPath);
  for (const brain of runs) {
    assert.equal(brain.config.data_dir, expected);
    assert.equal(brain.options.env.KIRIAN_V1_DATA_DIR, expected);
  }
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), hostConfig());
  // No real backend ran, so choosing a path itself must not create a data directory.
  await assert.rejects(access(environment.APPDATA), { code: 'ENOENT' });
});

test('environment data_dir wins without changing the source config or deleting existing durable data on close or failure', async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'kirian-launcher-durable-'));
  const marker = join(dataDirectory, 'existing-database-marker');
  await writeFile(marker, 'persistent data fixture');
  t.after(async () => { await unlink(marker); await rmdir(dataDirectory); });
  const source = { ...hostConfig(), data_dir: './host-preference-is-preserved' };
  const configFile = await fixture(t, source);
  for (const failStartup of [false, true]) {
    const run = runtime({ environment: { KIRIAN_V1_DATA_DIR: dataDirectory } });
    if (failStartup) run.dependencies.request = async () => ({ ok: false });
    if (failStartup) await assert.rejects(launchLocal(['--config', configFile], run.dependencies), /Brain startup unavailable/);
    else {
      const launcher = await launchLocal(['--config', configFile], run.dependencies);
      t.after(() => launcher.stop());
      const app = run.calls[1].child;
      app.exitCode = 0; app.emit('exit', 0);
      assert.equal(await launcher.done, 0);
    }
    const brain = run.calls[0];
    assert.equal(brain.options.env.KIRIAN_V1_DATA_DIR, dataDirectory);
    assert.equal(brain.config.data_dir, source.data_dir);
    await assert.rejects(access(brain.configPath), { code: 'ENOENT' });
    await assert.rejects(access(dirname(brain.configPath)), { code: 'ENOENT' });
    assert.equal(await readFile(marker, 'utf8'), 'persistent data fixture');
    assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), source);
  }
});

test('a test launch without an isolated profile or explicit directory never spawns a backend', async () => {
  const run = runtime({ environment: { KIRIAN_TEST_PROFILE: undefined, APPDATA: '/must-not-use' } });
  await assert.rejects(launchLocal([], run.dependencies), /requires KIRIAN_TEST_PROFILE/);
  assert.deepEqual(run.calls, []);
});
