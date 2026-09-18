import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({ stdin: { contents: "export { LocalPreferences } from './src/main/local-preferences.ts';", loader: 'ts',
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'contracts-entry', setup(api) { api.onResolve({ filter: /^@kirian\/contracts$/ }, () => ({ path: import.meta.resolve('@kirian/contracts'), external: true })); } }] });
const { LocalPreferences } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const identity = { instance_id: 'preferences-test', mode: 'personal', principal_id: 'owner' };
const filename = (root, owner = identity) => join(root, createHash('sha256').update(JSON.stringify([owner.instance_id, owner.mode, owner.principal_id])).digest('hex') + '.json');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kirian-preferences-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert(basename(directory).startsWith('kirian-preferences-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const root = join(directory, 'nested', 'preferences');
  return { directory, root, preferences: new LocalPreferences(root) };
}

test('first settings write creates its directory and voice, conversation and pin state survive restart', t => {
  const { root, preferences } = fixture(t);
  assert.deepEqual(preferences.read(identity), { voiceEnabled: true, conversationId: null });
  assert.equal(preferences.pinned(), false);
  preferences.write(identity, { voiceEnabled: false });
  preferences.write(identity, { conversationId: 'conversation-1' });
  preferences.savePinned(true);
  const restored = new LocalPreferences(root);
  assert.deepEqual(restored.read(identity), { voiceEnabled: false, conversationId: 'conversation-1' });
  assert.equal(restored.pinned(), true);
  const view = restored.read(identity); view.voiceEnabled = true;
  assert.equal(restored.read(identity).voiceEnabled, false);
  restored.write(identity, { conversationId: null });
  assert.deepEqual(new LocalPreferences(root).read(identity), { voiceEnabled: false, conversationId: null });
});

test('instance, principal and personal/public identities use distinct local preference files', t => {
  const { root, preferences } = fixture(t);
  const owners = [identity, { ...identity, principal_id: 'other' }, { ...identity, instance_id: 'other-instance' }, { ...identity, mode: 'public_demo' }];
  owners.forEach((owner, index) => preferences.write(owner, { voiceEnabled: index % 2 === 0, conversationId: 'conversation-' + index }));
  assert.equal(new Set(owners.map(owner => filename(root, owner))).size, 4);
  owners.forEach((owner, index) => assert.deepEqual(new LocalPreferences(root).read(owner), { voiceEnabled: index % 2 === 0, conversationId: 'conversation-' + index }));
});

test('invalid updates and IDs never poison the last valid preferences file', t => {
  const { root, preferences } = fixture(t);
  preferences.write(identity, { voiceEnabled: false, conversationId: 'valid-conversation' });
  const before = readFileSync(filename(root));
  for (const update of [{ voiceEnabled: 'false' }, { conversationId: 5 }, { conversationId: 'valid-conversation\n' },
    { conversationId: '.invalid' }, { conversationId: '../escape' }, { conversationId: 'x'.repeat(129) }, { surprise: true }, []]) {
    assert.throws(() => preferences.write(identity, update));
    assert.deepEqual(readFileSync(filename(root)), before);
  }
  preferences.savePinned(false); const pinnedBefore = readFileSync(join(root, 'window.json'));
  assert.throws(() => preferences.savePinned('true'));
  assert.deepEqual(readFileSync(join(root, 'window.json')), pinnedBefore);
});

test('malformed or oversized stored settings are reported without silent reset or overwrite', t => {
  const { root, preferences } = fixture(t);
  mkdirSync(root, { recursive: true });
  for (const content of ['{ broken', JSON.stringify({ voiceEnabled: true, conversationId: 'conv\n' }),
    JSON.stringify({ voiceEnabled: true, conversationId: null, extra: 1 }), ' '.repeat(8193)]) {
    writeFileSync(filename(root), content);
    assert.throws(() => preferences.read(identity));
    assert.throws(() => preferences.write(identity, { voiceEnabled: false }));
    assert.equal(readFileSync(filename(root), 'utf8'), content);
  }
  writeFileSync(join(root, 'window.json'), JSON.stringify({ alwaysOnTop: 1 }));
  assert.throws(() => preferences.pinned());
});

test('a preferences directory junction cannot redirect writes outside the owned directory', t => {
  const { directory, root, preferences } = fixture(t), outside = join(directory, 'outside');
  mkdirSync(dirname(root), { recursive: true }); mkdirSync(outside);
  symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => preferences.write(identity, { voiceEnabled: false }));
  assert.throws(() => preferences.savePinned(true));
  assert.deepEqual(readdirSync(outside), []);
});
