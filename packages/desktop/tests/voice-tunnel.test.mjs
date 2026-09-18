import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { parseVoiceTunnelOptions, voiceTunnelArguments, startVoiceTunnel, verifyWindowsVoiceListeners } from '../scripts/start-voice-tunnel.mjs';

const args = ['--ssh', 'owner@voice-host', '--identity', 'test key', '--known-hosts', 'verified hosts'];

test('voice forwarding preserves host verification and never forwards Ollama', () => {
  const options = parseVoiceTunnelOptions(args);
  const actual = voiceTunnelArguments(options);
  assert.deepEqual(actual.filter((_, i) => actual[i - 1] === '-L'),
    ['127.0.0.1:19882:127.0.0.1:19882', '127.0.0.1:18098:127.0.0.1:8098']);
  for (const flag of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'IdentitiesOnly=yes', 'UpdateHostKeys=no',
    'HostKeyAlgorithms=ssh-ed25519', 'ConnectTimeout=10', 'ExitOnForwardFailure=yes', 'ForwardAgent=no', 'PermitLocalCommand=no'])
    assert.ok(actual.includes(flag), flag);
  assert.deepEqual(actual.slice(0, 4), ['-F', 'none', '-N', '-T']);
  assert.equal(actual.at(-1), 'owner@voice-host');
  assert.ok(actual.includes('UserKnownHostsFile="' + options.knownHosts.replaceAll('\\', '/') + '"'));
  assert.ok(!actual.join(' ').includes('11434'));
});

test('server model forwarding is opt-in, never lands on local 11434 and joins Windows ownership checks', async () => {
  const options = parseVoiceTunnelOptions([...args, '--remote-tts-port', '19882', '--remote-stt-port', '18098', '--llm-port', '21434']);
  assert.equal(options.llmPort, 21434); assert.equal(options.remoteLlmPort, 11434);
  const actual = voiceTunnelArguments(options);
  assert.deepEqual(actual.filter((_, i) => actual[i - 1] === '-L'),
    ['127.0.0.1:19882:127.0.0.1:19882', '127.0.0.1:18098:127.0.0.1:18098', '127.0.0.1:21434:127.0.0.1:11434']);
  assert.equal(parseVoiceTunnelOptions([...args, '--llm-port', '21434', '--remote-llm-port', '21435']).remoteLlmPort, 21435);
  assert.equal(parseVoiceTunnelOptions(args).llmPort, null);
  for (const extra of [['--llm-port', '11434'], ['--llm-port', '19882'], ['--llm-port', '18098'], ['--remote-llm-port', '11434'],
    ['--llm-port', '21434', '--remote-llm-port', '19882'], ['--llm-port', '21434', '--remote-llm-port', '8098'], ['--llm-port', '0'], ['--llm-port', '21434\ncmd']])
    assert.throws(() => parseVoiceTunnelOptions([...args, ...extra]), extra.join(' '));
  const child = { pid: 1234, exitCode: null, killed: false };
  const rows = ports => ({ execute: async () => ({ stdout: ports.map(port => `  TCP    127.0.0.1:${port}    0.0.0.0:0    LISTENING    ${child.pid}`).join('\r\n') }) });
  await verifyWindowsVoiceListeners(options, child, rows([19882, 18098, 21434]));
  let time = 0;
  await assert.rejects(verifyWindowsVoiceListeners(options, child, { ...rows([19882, 18098]), now: () => time, pause: async () => { time += 20000; } }), /every owned/);
  const f = fixture();
  await startVoiceTunnel([...args, '--llm-port', '21434'], { ...f.dependencies, checkPortFree: async port => { if (port === 21434) throw Error('busy 21434'); } })
    .then(() => assert.fail('busy llm port accepted'), error => assert.match(error.message, /busy 21434/));
  assert.equal(f.calls.length, 0);
});

test('ambiguous arguments, option injection and conflicting ports fail before starting SSH', () => {
  for (const input of [[], args.slice(0, -1), [...args, '--ssh', 'different@host'], [...args, '--unknown', 'value'],
    ['--ssh', '-oProxyCommand=bad', ...args.slice(2)], ['--ssh', 'owner@host\ncommand', ...args.slice(2)],
    [...args, '--tts-port', '11434'], [...args, '--tts-port', '18098'], [...args, '--stt-port', '65536'],
    [...args, '--stt-port', '0'], [...args, '--stt-port', '1024.5']]) assert.throws(() => parseVoiceTunnelOptions(input));
  assert.throws(() => voiceTunnelArguments({ ...parseVoiceTunnelOptions(args), knownHosts: 'bad"path' }));
});

test('isolated Kirian server ports are forwarded while local ports keep their defaults', () => {
  const options = parseVoiceTunnelOptions([...args, '--remote-tts-port', '19882', '--remote-stt-port', '18098']);
  const actual = voiceTunnelArguments(options);
  assert.deepEqual(actual.filter((_, i) => actual[i - 1] === '-L'),
    ['127.0.0.1:19882:127.0.0.1:19882', '127.0.0.1:18098:127.0.0.1:18098']);
  assert.equal(options.ttsPort, 19882); assert.equal(options.sttPort, 18098);
});

test('remote ports reject injection, invalid ranges, duplicate flags, Ollama and same-server conflicts', () => {
  for (const key of ['--remote-tts-port', '--remote-stt-port']) {
    for (const value of ['0', '22', '1023', '65536', '1.5', 'NaN', '-1', '11434', '19882:other:22', '18098\ncommand'])
      assert.throws(() => parseVoiceTunnelOptions([...args, key, value]));
    assert.throws(() => parseVoiceTunnelOptions([...args, key, '20000', key, '20001']));
  }
  assert.throws(() => parseVoiceTunnelOptions([...args, '--remote-tts-port', '8098']));
  assert.throws(() => parseVoiceTunnelOptions([...args, '--remote-stt-port', '19882']));
  const options = parseVoiceTunnelOptions([...args, '--remote-tts-port', '1024', '--remote-stt-port', '65535']);
  assert.equal(options.remoteTtsPort, 1024); assert.equal(options.remoteSttPort, 65535);
});

function fixture() {
  const child = new EventEmitter(), signals = new EventEmitter(), calls = [], errors = [];
  child.killed = false; child.killCount = 0;
  child.kill = () => { child.killed = true; child.killCount++; queueMicrotask(() => child.emit('exit', null)); };
  return { child, signals, calls, errors, dependencies: { signals, platform: 'win32', environment: { SystemRoot: 'C:/Windows' },
    checkAccess: async () => {}, checkPortFree: async () => {}, verifyListeners: async () => {}, log: () => {}, reportError: value => errors.push(value),
    spawnProcess: (...values) => { calls.push(values); return child; } } };
}

test('Ctrl+C closes only its owned child and releases listeners', async () => {
  const f = fixture(), tunnel = await startVoiceTunnel(args, f.dependencies);
  assert.match(f.calls[0][0].replaceAll('\\', '/'), /Windows\/System32\/OpenSSH\/ssh.exe$/);
  assert.deepEqual(f.calls[0][2], { windowsHide: true, shell: false, stdio: ['ignore', 'inherit', 'inherit'] });
  f.signals.emit('SIGINT'); tunnel.stop();
  assert.equal(await tunnel.done, 0); assert.equal(f.child.killCount, 1);
  assert.equal(f.signals.listenerCount('SIGINT') + f.signals.listenerCount('SIGTERM'), 0);
});

test('authentication, occupied-port and spawn failures cannot silently report success', async () => {
  for (const event of ['exit', 'error']) {
    const f = fixture(), tunnel = await startVoiceTunnel(args, f.dependencies);
    if (event === 'exit') f.child.emit('exit', 255); else f.child.emit('error', Error('unavailable'));
    assert.notEqual(await tunnel.done, 0); assert.equal(f.errors.length, 1);
    assert.equal(f.signals.listenerCount('SIGINT') + f.signals.listenerCount('SIGTERM'), 0);
  }
});

test('unreadable connection files do not spawn SSH or register signal handlers', async () => {
  const f = fixture();
  await assert.rejects(startVoiceTunnel(args, { ...f.dependencies, checkAccess: async () => { throw Error('denied'); } }));
  assert.equal(f.calls.length, 0); assert.equal(f.signals.listenerCount('SIGINT'), 0);
});

test('occupied forwarding ports fail before SSH can replace an existing listener on Windows', async () => {
  const f = fixture(), checked = [];
  await assert.rejects(startVoiceTunnel(args, { ...f.dependencies, checkPortFree: async port => {
    checked.push(port); if (port === 18098) throw Error('already in use');
  } }), /already in use/);
  assert.deepEqual(checked, [19882, 18098]); assert.equal(f.calls.length, 0);
  assert.equal(f.signals.listenerCount('SIGINT'), 0);
});

test('Windows readiness requires both loopback listeners owned by this exact SSH PID', async () => {
  const options = parseVoiceTunnelOptions(args), child = { pid: 1234, exitCode: null, killed: false };
  const correct = [19882, 18098].map(LocalPort => ({ LocalPort, LocalAddress: '127.0.0.1', OwningProcess: child.pid }));
  const inspect = rows => ({ execute: async () => ({ stdout: rows.map(row => `  TCP    ${row.LocalAddress}:${row.LocalPort}    0.0.0.0:0    LISTENING    ${row.OwningProcess}`).join('\r\n') }) });
  await verifyWindowsVoiceListeners(options, child, inspect(correct));
  await assert.rejects(verifyWindowsVoiceListeners(options, child, inspect([{ ...correct[0], OwningProcess: 99 }])), /another listener/);
  await assert.rejects(verifyWindowsVoiceListeners(options, child, inspect([{ ...correct[0], LocalAddress: '0.0.0.0' }])), /another listener/);
  let time = 0;
  await assert.rejects(verifyWindowsVoiceListeners(options, child, { ...inspect([correct[0]]), now: () => time, pause: async () => { time += 20000; } }), /every owned/);
});

test('failed ownership verification closes only the newly created SSH', async () => {
  const f = fixture();
  await assert.rejects(startVoiceTunnel(args, { ...f.dependencies, verifyListeners: async () => { throw Error('foreign listener'); } }), /foreign listener/);
  assert.equal(f.child.killCount, 1); assert.equal(f.signals.listenerCount('SIGINT'), 0);
});

test('netstat errors and an exited SSH cannot be accepted as readiness', async () => {
  const options = parseVoiceTunnelOptions(args), child = { pid: 1234, exitCode: null, killed: false };
  await assert.rejects(verifyWindowsVoiceListeners(options, child, { execute: async () => { throw Error('netstat timeout'); } }), /netstat timeout/);
  let calls = 0;
  await assert.rejects(verifyWindowsVoiceListeners(options, { ...child, exitCode: 255 }, {
    execute: async () => { calls++; return { stdout: '' }; }
  }), /every owned/);
  assert.equal(calls, 0);
});
