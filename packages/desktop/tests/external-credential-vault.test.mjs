import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({ stdin: {
  contents: "export { SecureCredentialVault } from './src/main/external/credential-vault.ts';", loader: 'ts',
  resolveDir: fileURLToPath(new URL('../', import.meta.url)),
}, bundle: true, write: false, platform: 'node', format: 'esm' });
const { SecureCredentialVault } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const storageError = { message: 'credential_storage_unavailable' };
const encryptionError = { message: 'credential_encryption_unavailable' };
const filename = (root, id = 'account-1') => join(root, createHash('sha256').update(id).digest('hex') + '.json');

function encryption() {
  const key = randomBytes(32);
  return {
    available: true, backend: 'gnome_libsecret',
    isEncryptionAvailable() { return this.available; },
    getSelectedStorageBackend() { return this.backend; },
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kirian-credential-test-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert(basename(directory).startsWith('kirian-credential-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const root = join(directory, 'owner', 'credentials'), adapter = encryption();
  return { directory, root, adapter, vault: new SecureCredentialVault(root, adapter) };
}

test('credentials survive restart as encrypted JSON without plaintext or temporary files', t => {
  const { root, adapter, vault } = fixture(t);
  assert.equal(vault.get('account-1'), undefined);
  assert.equal(existsSync(root), false);
  const value = { accessToken: 'fixture-access-secret-197', refreshToken: 'fixture-refresh-secret-643', expiry: 99, scopes: ['calendar'] };
  vault.set('account-1', value);
  const bytes = readFileSync(filename(root), 'utf8');
  assert(!bytes.includes(value.accessToken)); assert(!bytes.includes(value.refreshToken)); assert(!bytes.includes('accessToken'));
  assert.deepEqual(readdirSync(root), [basename(filename(root))]);
  const restored = new SecureCredentialVault(root, adapter);
  assert.deepEqual(restored.get('account-1'), value);
  const view = restored.get('account-1'); view.scopes.push('other');
  assert.deepEqual(restored.get('account-1'), value);
  restored.set('account-1', { accessToken: 'rotated-fixture-token' });
  assert.deepEqual(restored.get('account-1'), { accessToken: 'rotated-fixture-token' });
});

test('unavailable encryption and insecure or unknown storage backends never persist plaintext', t => {
  const { root, adapter, vault } = fixture(t);
  adapter.available = false;
  assert.throws(() => vault.set('account-1', { token: 'secret' }), encryptionError);
  assert.throws(() => vault.get('account-1'), encryptionError);
  assert.equal(existsSync(root), false);
  adapter.available = true;
  for (const backend of ['basic_text', 'unknown', '', 'unrecognized_backend']) {
    adapter.backend = backend;
    assert.throws(() => vault.set('account-1', { token: 'secret' }), encryptionError);
  }
  assert.equal(existsSync(root), false);
  delete adapter.getSelectedStorageBackend;
  if (process.platform === 'linux') assert.throws(() => vault.set('account-1', { token: 'secret' }), encryptionError);
  else {
    vault.set('account-1', { token: 'windows-dpapi-adapter-fixture' });
    assert.equal(vault.get('account-1').token, 'windows-dpapi-adapter-fixture');
  }
});

test('invalid IDs cannot traverse paths, use device names, or produce secret-bearing errors', t => {
  const { root, vault } = fixture(t);
  for (const id of ['', '../outside', 'a/b', 'a\\b', '.hidden', 'account\n', 'x'.repeat(129), '한글', null, 8]) {
    for (const operation of [() => vault.get(id), () => vault.set(id, { token: 'secret' }), () => vault.delete(id)])
      assert.throws(operation, { message: 'invalid_credential_id' });
  }
  for (const id of ['CON', 'NUL', 'account:calendar']) vault.set(id, { token: id });
  assert.equal(readdirSync(root).length, 3);
});

test('invalid and oversized JSON values preserve the last complete encrypted file', t => {
  const { root, vault } = fixture(t);
  vault.set('account-1', { token: 'previous' }); const before = readFileSync(filename(root));
  const cyclic = {}; cyclic.self = cyclic;
  let accessed = false;
  const getter = Object.defineProperty({}, 'token', { enumerable: true, get() { accessed = true; return 'secret'; } });
  const invalid = [undefined, 1n, NaN, Infinity, { token: undefined }, { token() {} }, cyclic, getter,
    new Date(), new Map(), Array(1), { [Symbol('secret')]: 'secret' }, 'x'.repeat(65537)];
  for (const value of invalid) {
    assert.throws(() => vault.set('account-1', value), { message: 'invalid_credential_value' });
    assert.deepEqual(readFileSync(filename(root)), before);
  }
  assert.equal(accessed, false);
});

test('corrupt, oversized, invalid base64 and unexpected envelopes fail closed without overwrite', t => {
  const { root, vault } = fixture(t);
  vault.set('account-1', { token: 'previous' });
  for (const content of ['{broken', ' '.repeat(262145), JSON.stringify({ version: 2, ciphertext: 'aGVsbG8=' }),
    JSON.stringify({ version: 1, ciphertext: 'aGVsbG8=\n' }), JSON.stringify({ version: 1, ciphertext: 'aGVsbG8=', secret: 'extra' }),
    JSON.stringify({ version: 1, ciphertext: '' })]) {
    writeFileSync(filename(root), content);
    assert.throws(() => vault.get('account-1'), storageError);
    assert.throws(() => vault.set('account-1', { token: 'replacement' }), storageError);
    assert.equal(readFileSync(filename(root), 'utf8'), content);
  }
});

test('ciphertext tampering or copying across credential IDs and identity roots is rejected', t => {
  const { directory, root, adapter, vault } = fixture(t);
  vault.set('account-1', { token: 'owner-secret' });
  copyFileSync(filename(root), filename(root, 'account-2'));
  assert.throws(() => vault.get('account-2'), storageError);
  const otherRoot = join(directory, 'other-owner', 'credentials'); mkdirSync(otherRoot, { recursive: true });
  copyFileSync(filename(root), filename(otherRoot));
  assert.throws(() => new SecureCredentialVault(otherRoot, adapter).get('account-1'), storageError);
  const envelope = JSON.parse(readFileSync(filename(root), 'utf8'));
  const corrupted = Buffer.from(envelope.ciphertext, 'base64'); corrupted[corrupted.length - 1] ^= 1;
  writeFileSync(filename(root), JSON.stringify({ ...envelope, ciphertext: corrupted.toString('base64') }));
  assert.throws(() => vault.get('account-1'), storageError);
});

test('encryption exceptions never expose the underlying error, credential, or filesystem path', t => {
  const { root, adapter, vault } = fixture(t);
  vault.set('account-1', { token: 'previous' }); const before = readFileSync(filename(root));
  adapter.encryptString = () => { throw new Error('fixture-secret ' + root); };
  assert.throws(() => vault.set('account-1', { token: 'fixture-secret' }), encryptionError);
  assert.deepEqual(readFileSync(filename(root)), before);
  adapter.decryptString = () => { throw new Error('fixture-secret ' + root); };
  assert.throws(() => vault.get('account-1'), storageError);
  adapter.isEncryptionAvailable = () => { throw new Error('fixture-secret ' + root); };
  assert.throws(() => vault.get('account-1'), encryptionError);
});

test('invalid encryption results and loss of the secure backend preserve the last stored credential', t => {
  const { root, adapter, vault } = fixture(t);
  vault.set('account-1', { token: 'previous' }); const before = readFileSync(filename(root));
  for (const result of [undefined, 'plain-secret', Buffer.alloc(0), Buffer.alloc(131073)]) {
    adapter.encryptString = () => result;
    assert.throws(() => vault.set('account-1', { token: 'replacement' }), encryptionError);
    assert.deepEqual(readFileSync(filename(root)), before);
  }
  adapter.encryptString = () => { adapter.available = false; return randomBytes(16); };
  assert.throws(() => vault.set('account-1', { token: 'replacement' }), encryptionError);
  assert.deepEqual(readFileSync(filename(root)), before);
});

test('a directory changed during encryption is checked again before any write', t => {
  const { root, adapter, vault } = fixture(t);
  vault.set('account-1', { token: 'previous' });
  const encryptString = adapter.encryptString.bind(adapter);
  adapter.encryptString = value => { renameSync(root, root + '-original'); mkdirSync(root); return encryptString(value); };
  assert.throws(() => vault.set('account-1', { token: 'replacement' }), storageError);
  assert.deepEqual(readdirSync(root), []);
});

test('decrypted contents require the bound identity, ID, envelope and strict bounded JSON value', t => {
  const { root, adapter, vault } = fixture(t);
  vault.set('account-1', { token: 'previous' });
  const envelope = JSON.parse(readFileSync(filename(root), 'utf8'));
  const decrypted = JSON.parse(adapter.decryptString(Buffer.from(envelope.ciphertext, 'base64')));
  for (const content of ['not JSON', JSON.stringify({ ...decrypted, scope: 'other-owner' }),
    JSON.stringify({ ...decrypted, id: 'other-id' }), JSON.stringify({ ...decrypted, version: 2 }),
    JSON.stringify({ ...decrypted, extra: 1 }), JSON.stringify({ ...decrypted, value: 'x'.repeat(65537) })]) {
    adapter.decryptString = () => content;
    assert.throws(() => vault.get('account-1'), storageError);
    assert.throws(() => vault.set('account-1', { token: 'replacement' }), storageError);
  }
});

test('explicit deletion works without encryption and can remove corrupt stored credentials', t => {
  const { root, adapter, vault } = fixture(t);
  vault.delete('missing'); assert.equal(existsSync(root), false);
  vault.set('account-1', { token: 'previous' });
  adapter.available = false; vault.delete('account-1');
  assert.deepEqual(readdirSync(root), []);
  writeFileSync(filename(root), '{ broken'); vault.delete('account-1');
  assert.deepEqual(readdirSync(root), []);
});

test('relative, device, parent traversal, and filesystem-root storage paths are rejected', () => {
  for (const root of ['relative/path', join(tmpdir(), '..', basename(tmpdir())) + '/../vault', '', '\\0', process.platform === 'win32' ? 'C:\\' : '/'])
    assert.throws(() => new SecureCredentialVault(root, encryption()), { message: 'invalid_credential_root' });
  if (process.platform === 'win32') for (const root of ['\\\\?\\C:\\vault', '\\\\server\\share\\vault', 'C:\\vault:stream'])
    assert.throws(() => new SecureCredentialVault(root, encryption()), { message: 'invalid_credential_root' });
});

test('root or ancestor junctions cannot redirect credential operations', t => {
  const { directory, root, adapter } = fixture(t), outside = join(directory, 'outside'); mkdirSync(outside);
  mkdirSync(dirname(root)); symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  const vault = new SecureCredentialVault(root, adapter);
  for (const operation of [() => vault.get('account-1'), () => vault.set('account-1', { token: 'secret' }), () => vault.delete('account-1')])
    assert.throws(operation, storageError);
  const parent = join(directory, 'alias'); symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new SecureCredentialVault(join(parent, 'credentials'), adapter).set('account-1', { token: 'secret' }), storageError);
  assert.deepEqual(readdirSync(outside), []);
});

test('replacement of a previously checked root directory is rejected', t => {
  const { root, vault } = fixture(t);
  vault.set('account-1', { token: 'previous' }); renameSync(root, root + '-original'); mkdirSync(root);
  for (const operation of [() => vault.get('account-1'), () => vault.set('account-1', { token: 'new' }), () => vault.delete('account-1')])
    assert.throws(operation, storageError);
  assert.deepEqual(readdirSync(root), []);
});

test('hardlinks and non-file credential destinations cannot redirect reads, replacements or deletion', t => {
  const { root, vault } = fixture(t);
  vault.set('account-1', { token: 'previous' }); linkSync(filename(root), filename(root, 'linked'));
  for (const operation of [() => vault.get('account-1'), () => vault.set('account-1', { token: 'new' }), () => vault.delete('account-1')])
    assert.throws(operation, storageError);
  const directoryFile = filename(root, 'directory'); mkdirSync(directoryFile);
  for (const operation of [() => vault.get('directory'), () => vault.set('directory', { token: 'new' }), () => vault.delete('directory')])
    assert.throws(operation, storageError);
});
