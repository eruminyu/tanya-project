import { spawn, execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const usage = [
  'Usage: node scripts/start-voice-tunnel.mjs --ssh user@host --identity key-path --known-hosts verified-file [--tts-port 19882] [--stt-port 18098] [--remote-tts-port 19882] [--remote-stt-port 8098] [--llm-port 21434 [--remote-llm-port 11434]]',
  '',
  'Forwards two voice ports over verified Ed25519 SSH. Default server ports: Qwen3-TTS 19882, STT 8098.',
  'For prepared Kirian services, select --remote-tts-port 19882 --remote-stt-port 18098.',
  '--llm-port additionally forwards the server Ollama (default remote 11434) to that distinct local port,',
  'for a host config whose model binding is http://127.0.0.1:<llm-port> with boundary private_lan.',
  'Keep this process running while using Kirian. Ctrl+C closes its tunnel.',
  'Local endpoints: http://127.0.0.1:19882/tts and http://127.0.0.1:18098/stt/transcriptions.',
  'Declare both voice endpoints private_lan in Kirian. Local Ollama on 11434 stays unchanged.',
  'The identity and known-hosts files must already exist; this script does not create keys or accept unknown hosts.',
  'Connection failures exit visibly. Run the same command to reconnect; no server services are changed.',
  'Windows startup verifies that this SSH process owns every forwarded IPv4 loopback listener.',
].join('\n');

export function parseVoiceTunnelOptions(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--ssh', '--identity', '--known-hosts', '--tts-port', '--stt-port', '--remote-tts-port', '--remote-stt-port', '--llm-port', '--remote-llm-port'].includes(key)
      || !value || value.startsWith('--') || /[\0\r\n]/.test(value) || Object.hasOwn(values, key)) throw Error(usage);
    values[key] = value;
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/.test(values['--ssh'] ?? '')
    || !values['--identity'] || !values['--known-hosts']) throw Error(usage);
  const port = (key, fallback) => {
    const value = values[key] ?? String(fallback);
    if (!/^[0-9]+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw Error('Invalid voice port.');
    return Number(value);
  };
  const ttsPort = port('--tts-port', 19882), sttPort = port('--stt-port', 18098);
  const remoteTtsPort = port('--remote-tts-port', 19882), remoteSttPort = port('--remote-stt-port', 8098);
  if (ttsPort === sttPort || remoteTtsPort === remoteSttPort || [ttsPort, sttPort, remoteTtsPort, remoteSttPort].includes(11434))
    throw Error('Voice ports must be distinct on each host and must not replace Ollama.');
  // The server model is forwarded only on request and never onto the local Ollama port.
  if (values['--remote-llm-port'] !== undefined && values['--llm-port'] === undefined) throw Error(usage);
  const llmPort = values['--llm-port'] === undefined ? null : port('--llm-port', 0);
  const remoteLlmPort = llmPort === null ? null : port('--remote-llm-port', 11434);
  if (llmPort !== null && (llmPort === 11434 || [ttsPort, sttPort].includes(llmPort) || [remoteTtsPort, remoteSttPort].includes(remoteLlmPort)))
    throw Error('The server model port must be distinct and must not replace local Ollama.');
  return { target: values['--ssh'], identity: resolve(values['--identity']), knownHosts: resolve(values['--known-hosts']),
    ttsPort, sttPort, remoteTtsPort, remoteSttPort, llmPort, remoteLlmPort };
}

export function voiceTunnelArguments(options) {
  // OpenSSH parses paths in -o using its config syntax, even with shell:false.
  const knownHosts = options.knownHosts.replaceAll('\\', '/');
  if (knownHosts.includes('"')) throw Error('Unsupported known-hosts path.');
  return ['-F', 'none', '-N', '-T', '-i', options.identity,
    '-o', 'UserKnownHostsFile="' + knownHosts + '"', '-o', 'GlobalKnownHostsFile=none',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'UpdateHostKeys=no', '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'ConnectTimeout=10',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no',
    '-L', `127.0.0.1:${options.ttsPort}:127.0.0.1:${options.remoteTtsPort}`,
    '-L', `127.0.0.1:${options.sttPort}:127.0.0.1:${options.remoteSttPort}`,
    ...(options.llmPort ? ['-L', `127.0.0.1:${options.llmPort}:127.0.0.1:${options.remoteLlmPort}`] : []), options.target];
}

export function checkVoicePortFree(port) {
  // Windows OpenSSH can bind an already-listening forwarding port even with
  // ExitOnForwardFailure. Refuse occupied ports before launching a second SSH.
  return new Promise((resolveFree, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = error => { socket.destroy(); error ? reject(error) : resolveFree(); };
    socket.once('connect', () => finish(Error(`Local voice port ${port} is already in use.`)));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED' ? null : Error(`Cannot check local voice port ${port}.`)));
    socket.setTimeout(1000, () => finish(Error(`Cannot check local voice port ${port}.`)));
  });
}

export async function verifyWindowsVoiceListeners(options, child, { environment = process.env,
  execute = promisify(execFile), pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms)),
  now = Date.now } = {}) {
  if (!Number.isInteger(child.pid) || child.pid < 1) throw Error('SSH process did not start.');
  const netstat = join(environment.SystemRoot ?? 'C:/Windows', 'System32', 'netstat.exe');
  const expected = [options.ttsPort, options.sttPort, ...(options.llmPort ? [options.llmPort] : [])];
  const deadline = now() + 20000;
  while (now() < deadline && !child.killed && child.exitCode === null) {
    const { stdout } = await execute(netstat, ['-ano', '-p', 'TCP'],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
    // Parse only the two requested listener rows; no other connection is logged.
    const rows = stdout.split(/\r?\n/).flatMap(line => {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 5 || fields[0] !== 'TCP' || fields[3] !== 'LISTENING') return [];
      const local = fields[1], separator = local.lastIndexOf(':'), port = Number(local.slice(separator + 1));
      if (!expected.includes(port)) return [];
      return [{ LocalAddress: local.slice(0, separator), LocalPort: port, OwningProcess: Number(fields[4]) }];
    });
    if (rows.some(row => row.OwningProcess !== child.pid || row.LocalAddress !== '127.0.0.1'))
      throw Error('A voice port belongs to another listener. Only this SSH process will be stopped.');
    if (rows.length === expected.length && expected.every(port => rows.some(row => row.LocalPort === port))) return;
    await pause(100);
  }
  throw Error('SSH did not establish every owned forwarded listener.');
}

export async function startVoiceTunnel(args, { spawnProcess = spawn, checkAccess = access, platform = process.platform,
  checkPortFree = checkVoicePortFree, verifyListeners = verifyWindowsVoiceListeners,
  environment = process.env, signals = process, log = console.log, reportError = console.error } = {}) {
  const options = parseVoiceTunnelOptions(args);
  await checkAccess(options.identity); await checkAccess(options.knownHosts);
  await checkPortFree(options.ttsPort); await checkPortFree(options.sttPort);
  if (options.llmPort) await checkPortFree(options.llmPort);
  const ssh = platform === 'win32' ? join(environment.SystemRoot ?? 'C:/Windows', 'System32', 'OpenSSH', 'ssh.exe') : 'ssh';
  const child = spawnProcess(ssh, voiceTunnelArguments(options), { windowsHide: true, shell: false, stdio: ['ignore', 'inherit', 'inherit'] });
  let stopped = false, finished = false;
  const stop = () => { stopped = true; if (!finished && !child.killed) child.kill(); };
  signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
  const done = new Promise(resolveDone => {
    const finish = code => {
      if (finished) return; finished = true;
      signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
      resolveDone(code);
    };
    child.once('error', () => { reportError('SSH could not start. Check the installed OpenSSH client and verified connection files.'); finish(1); });
    child.once('exit', code => { if (!stopped && code !== 0) reportError('Voice tunnel disconnected. Re-run the command after checking the connection.'); finish(stopped ? 0 : code ?? 1); });
  });
  log(`Starting voice tunnel: TTS 127.0.0.1:${options.ttsPort}, STT 127.0.0.1:${options.sttPort}`
    + (options.llmPort ? `, server model 127.0.0.1:${options.llmPort}` : '') + '. Local Ollama is unchanged.');
  try {
    if (platform === 'win32') await verifyListeners(options, child, { environment });
    if (finished || stopped) throw Error('SSH exited during startup.');
  } catch (error) { stop(); await done; throw error; }
  return { child, stop, done, options };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') console.log(usage);
  else {
    try { process.exitCode = await (await startVoiceTunnel(process.argv.slice(2))).done; }
    catch (error) { console.error('Voice tunnel setup failed: ' + error.message); process.exitCode = 1; }
  }
}
