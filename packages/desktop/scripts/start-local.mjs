import { spawn } from 'node:child_process';
import { createConnection, createServer, isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, unlink, rmdir, access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = fileURLToPath(new URL('../', import.meta.url));
export const usage = [
  'Usage: node scripts/start-local.mjs [--config host.json] [--ssh user@host --identity key-path] [--model model-id] [--images true|false]',
  '',
  '--config uses the Brain host JSON (bindings, optional speech/transcription).',
  'Without --config, KIRIAN_V1_CONFIG_FILE is also supported; --config takes precedence.',
  '--ssh forwards each configured loopback host/port to a random local port.',
  'Use remote service URLs such as http://127.0.0.1:11434, :9881/tts, and :8098/stt/transcriptions.',
  'The temporary copy preserves model/voice/reference/prompt settings. Forwarded local',
  'boundaries become private_lan; explicit cloud boundaries are never downgraded.',
  'Non-loopback endpoints retain their explicitly configured URL and boundary.',
  'Brain data persists separately: KIRIAN_V1_DATA_DIR > host data_dir > the local default.',
  'The default is APPDATA/Kirian Development/brain, or ~/.kirian/brain without APPDATA.',
  'Test mode uses KIRIAN_TEST_PROFILE/brain and requires a test profile or explicit data directory.',
  'Closing Kirian removes only its temporary host config, never the Brain data directory.',
  '--model selects Ollama only when no host config is supplied. --help shows this text.',
  '--images declares verified image support for that model; it does not grant access to any screen.',
  'For a host config, set supports_images: true on the intended binding instead.',
].join('\n');

export function parseOptions(args, environment = process.env) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!['--ssh', '--identity', '--model', '--config', '--images'].includes(name) ||
        !value || value.startsWith('--') || Object.hasOwn(options, name))
      throw new Error(usage);
    options[name] = value;
  }
  const configFile = options['--config'] ?? environment.KIRIAN_V1_CONFIG_FILE;
  if (configFile && options['--model'])
    throw new Error('--model cannot override a host config; select the model in that config.');
  if (options['--images'] !== undefined && (configFile || !['true', 'false'].includes(options['--images'])))
    throw new Error('--images requires true or false and no host config; use supports_images in a host binding.');
  if (options['--identity'] && !options['--ssh'])
    throw new Error('--identity requires --ssh.');
  if (options['--ssh'] && (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(options['--ssh']) || !options['--identity']))
    throw new Error('An SSH user@host and explicit --identity path are required.');
  return { configFile, ssh: options['--ssh'], identity: options['--identity'],
    ...(options['--images'] !== undefined ? { supportsImages: options['--images'] === 'true' } : {}),
    model: options['--model'] ?? environment.KIRIAN_V1_OLLAMA_MODEL ?? 'qwen2.5:7b' };
}

function isLoopback(host) {
  return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function isPrivateAddress(host) {
  if (isLoopback(host)) return true;
  const octets = host.split('.').map(Number);
  return (isIP(host) === 4 && (octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168))) || /^\[f[cd][0-9a-f]{2}:/i.test(host);
}

function endpoints(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some((key) => !['identity', 'bindings', 'saved_default', 'speech', 'transcription', 'data_dir'].includes(key)) ||
      !Array.isArray(config.bindings) || config.bindings.length < 1 || config.bindings.length > 32)
    throw new Error('Invalid host config: expected Brain identity and bindings with optional speech/transcription.');
  if (config.data_dir != null) validateDataDirectory(config.data_dir);
  const result = [...config.bindings];
  if (config.speech != null) result.push(config.speech);
  if (config.transcription != null) result.push(config.transcription);
  for (const item of result) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.url !== 'string' ||
        Object.hasOwn(item, 'api_key'))
      throw new Error('Invalid host endpoint; provider credentials must use api_key_env.');
    let url;
    try { url = new URL(item.url); } catch { throw new Error('Invalid host endpoint URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
        url.search || url.hash || url.port === '0')
      throw new Error('Host endpoint URLs require HTTP(S), without credentials, query, or fragment.');
    if (!['local', 'private_lan', 'cloud'].includes(item.boundary))
      throw new Error('Host endpoints require an explicit local, private_lan, or cloud boundary.');
    if (item.boundary === 'cloud' && url.protocol !== 'https:')
      throw new Error('Cloud endpoints require HTTPS.');
    if (item.boundary === 'local' && !isLoopback(url.hostname))
      throw new Error('Local endpoints require loopback; declare the actual remote boundary in the host config.');
    if (item.boundary === 'private_lan' && !isPrivateAddress(url.hostname))
      throw new Error('Private LAN endpoints require loopback or a private IP address.');
  }
  return result;
}

function validateDataDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0'))
    throw new Error('The Brain data directory must be a non-empty path of at most 4096 characters.');
  return value;
}

/** Only choose a path here. The Brain owns storage creation; launcher cleanup
 * owns its generated host.json and must never own the durable data directory. */
export function resolveDataDirectory(config, environment = process.env) {
  if (environment.KIRIAN_V1_DATA_DIR !== undefined)
    return validateDataDirectory(environment.KIRIAN_V1_DATA_DIR);
  if (config.data_dir != null) return validateDataDirectory(config.data_dir);
  if (environment.KIRIAN_DESKTOP_TEST === '1') {
    if (!environment.KIRIAN_TEST_PROFILE?.trim())
      throw new Error('Test mode requires KIRIAN_TEST_PROFILE or an explicit Brain data directory.');
    return join(environment.KIRIAN_TEST_PROFILE, 'brain');
  }
  return environment.APPDATA?.trim()
    ? join(environment.APPDATA, 'Kirian Development', 'brain')
    : join(homedir(), '.kirian', 'brain');
}

/** The authenticated SSH host is the actual processing machine. A local tunnel
 * address cannot grant local-only context access to that remote machine. */
export async function prepareHostConfig(config, { ssh = false, allocatePort = availablePort } = {}) {
  const copy = structuredClone(config), forwards = [], ports = new Set(), mappings = new Map();
  for (const item of endpoints(copy)) {
    const url = new URL(item.url);
    if (!ssh || !isLoopback(url.hostname)) continue;
    // Keep IPv6 and alternate 127/8 targets distinct; localhost resolves on the SSH host.
    const remoteHost = url.hostname, remotePort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const key = remoteHost + ':' + remotePort;
    let mapping = mappings.get(key);
    if (!mapping) {
      let localPort;
      for (let attempt = 0; attempt < 20; attempt++) {
        localPort = await allocatePort();
        if (Number.isInteger(localPort) && localPort > 0 && localPort <= 65535 && !ports.has(localPort)) break;
        localPort = undefined;
      }
      if (localPort === undefined) throw new Error('Could not allocate distinct SSH forwarding ports.');
      ports.add(localPort);
      mapping = { localPort, remoteHost, remotePort };
      mappings.set(key, mapping);
      forwards.push(mapping);
    }
    // Retain the URL hostname and bind that same loopback address locally. This
    // preserves HTTPS certificate-name verification instead of rewriting it to 127.0.0.1.
    url.port = String(mapping.localPort);
    item.url = url.href;
    if (item.boundary === 'local') item.boundary = 'private_lan';
  }
  return { config: copy, forwards };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

function forwardListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = createConnection({ host: host.replace(/^\[|\]$/g, ''), port });
    let settled = false;
    const finish = (ready) => { if (settled) return; settled = true; socket.destroy(); resolve(ready); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

function defaultConfig(model, environment) {
  return { identity: { instance_id: 'personal-desktop', mode: 'personal', principal_id: 'owner' },
    bindings: [{ model: { provider_id: 'ollama', model_id: model, endpoint_id: 'personal-ollama' },
      label: model, kind: 'ollama', url: environment.KIRIAN_V1_OLLAMA_URL ?? 'http://127.0.0.1:11434',
      boundary: 'local', think: false, num_ctx: 8192 }] };
}

/** Dependencies are injectable for process-lifecycle tests, never CLI options. */
export async function launchLocal(args, {
  environment = process.env, spawnProcess = spawn, request = fetch,
  allocatePort = availablePort, probeForward = forwardListening,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log, reportError = console.error,
} = {}) {
  const options = parseOptions(args, environment);
  const python = environment.KIRIAN_PYTHON ?? join(root, '../../.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await access(python);
  let hostConfig;
  if (options.configFile) {
    try { hostConfig = JSON.parse(await readFile(resolve(options.configFile), 'utf8')); }
    catch { throw new Error('Could not read the host config as JSON.'); }
  } else {
    hostConfig = defaultConfig(options.model, environment);
    if (options.supportsImages !== undefined) hostConfig.bindings[0].supports_images = options.supportsImages;
  }
  const prepared = await prepareHostConfig(hostConfig, { ssh: Boolean(options.ssh), allocatePort });
  const dataDirectory = resolveDataDirectory(prepared.config, environment);
  // Preserve explicit host values in the copy; the environment is authoritative.
  if (prepared.config.data_dir == null) prepared.config.data_dir = dataDirectory;
  if (options.ssh && prepared.forwards.length === 0)
    throw new Error('--ssh requires at least one loopback endpoint in the host config.');
  const identity = options.identity ? resolve(options.identity) : undefined;
  if (identity) await access(identity);

  const children = [];
  let closed = false, temporaryDirectory, configPath, stopping;
  let finishStartup, finish;
  const startupFinished = new Promise((resolve) => { finishStartup = resolve; });
  const done = new Promise((resolve) => { finish = resolve; });
  const onSignal = () => void stop();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  function ensureOpen() { if (closed) throw new Error('Startup cancelled.'); }
  function killOwnedChildren() {
    for (const processChild of [...children].reverse())
      if (processChild.exitCode === null && !processChild.killed) processChild.kill();
  }
  function stop(code = 0) {
    if (stopping) return stopping;
    closed = true;
    stopping = (async () => {
      killOwnedChildren();
      // A signal during mkdir/write must not leave a later-created host.json behind.
      await startupFinished;
      killOwnedChildren();
      if (configPath) await unlink(configPath).catch(() => {});
      if (temporaryDirectory) await rmdir(temporaryDirectory).catch(() => {});
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      finish(code);
    })();
    return stopping;
  }
  function child(command, childArgs, env, cwd, app = false) {
    ensureOpen();
    const processChild = spawnProcess(command, childArgs, { cwd, env, stdio: 'inherit', windowsHide: true });
    children.push(processChild);
    processChild.once('error', () => { reportError(app ? 'Kirian process unavailable.' : 'Brain or SSH process unavailable.'); void stop(1); });
    processChild.once('exit', (code) => { if (!closed) void stop(app ? code ?? 0 : code || 1); });
    return processChild;
  }
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'kirian-v1-'));
    configPath = join(temporaryDirectory, 'host.json');
    ensureOpen();
    await writeFile(configPath, JSON.stringify(prepared.config), { mode: 0o600 });
    ensureOpen();
    const env = { ...environment, KIRIAN_V1_TOKEN: randomBytes(32).toString('hex'),
      KIRIAN_V1_CONFIG_FILE: configPath, KIRIAN_V1_DATA_DIR: dataDirectory };
    if (options.ssh) {
      const forwardArgs = prepared.forwards.flatMap(({ localPort, remoteHost, remotePort }) =>
        ['-L', remoteHost + ':' + localPort + ':' + remoteHost + ':' + remotePort]);
      child('ssh', ['-i', identity, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8', '-N', ...forwardArgs, options.ssh], environment, join(root, '../brain'));
      let ready = false;
      for (let i = 0; i < 100 && !closed; i++) {
        if ((await Promise.all(prepared.forwards.map(({ localPort, remoteHost }) => probeForward(localPort, remoteHost)))).every(Boolean)) {
          ready = true; break;
        }
        await pause(100);
      }
      if (!ready) throw new Error('SSH forwarding unavailable.');
      ensureOpen();
      log('SSH forwarding ready (' + prepared.forwards.length + ' service ports); actual host boundary: private_lan. Explicit cloud boundaries remain cloud.');
    }
    const usedPorts = new Set(prepared.forwards.map(({ localPort }) => localPort));
    let localPort;
    for (let i = 0; i < 20; i++) {
      localPort = await allocatePort();
      if (Number.isInteger(localPort) && localPort > 0 && localPort <= 65535 && !usedPorts.has(localPort)) break;
      localPort = undefined;
    }
    if (localPort === undefined) throw new Error('Could not allocate a Brain port.');
    const url = 'http://127.0.0.1:' + localPort;
    child(python, ['-m', 'uvicorn', 'rearchitecture.app:create_app', '--factory', '--host', '127.0.0.1',
      '--port', String(localPort), '--no-access-log', '--log-level', 'warning'], env, join(root, '../brain'));
    let ready = false;
    for (let i = 0; i < 150 && !closed; i++) {
      try {
        const response = await request(url + '/v1/config', {
          headers: { Authorization: 'Bearer ' + env.KIRIAN_V1_TOKEN }, signal: AbortSignal.timeout(300),
        });
        const ok = response.ok;
        await response.body?.cancel();
        if (ok) { ready = true; break; }
      } catch {}
      await pause(100);
    }
    if (!ready) throw new Error('Brain startup unavailable; check host config and Python v1 dependencies.');
    ensureOpen();
    const appEnv = { ...environment, KIRIAN_BRAIN_URL: url, KIRIAN_BRAIN_TOKEN: env.KIRIAN_V1_TOKEN };
    delete appEnv.ELECTRON_RUN_AS_NODE;
    delete appEnv.KIRIAN_V1_TOKEN;
    child(electron, [root], appEnv, root, true);
    log('Kirian connected to the local Brain. Closing Kirian also stops this Brain and SSH tunnel.');
    return { stop, done };
  } catch (error) {
    finishStartup();
    await stop(1);
    throw error;
  } finally {
    finishStartup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') console.log(usage);
  else {
    try {
      const launcher = await launchLocal(process.argv.slice(2));
      process.exitCode = await launcher.done;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
