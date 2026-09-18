import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileSummary, selectedSpecs, testEnvironment } from '../scripts/verify-pc-features.mjs';

test('PC fixture runner discards live endpoints, credentials and inherited profiles', () => {
  const env = testEnvironment({ PATH: 'tool-path', KIRIAN_LIVE_OLLAMA_URL: 'live', KIRIAN_LIVE_OLLAMA_MODEL: 'model',
    KIRIAN_BRAIN_TOKEN: 'secret', KIRIAN_TEST_PROFILE: 'real-user', ELECTRON_RUN_AS_NODE: '1', kirian_renderer_url: 'remote' },
  { executable: 'fixture.exe', python: 'python.exe' });
  assert.equal(env.PATH, 'tool-path');
  assert.equal(env.KIRIAN_PACKAGED_EXE, 'fixture.exe');
  assert.equal(env.KIRIAN_PYTHON, 'python.exe');
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(Object.keys(env).some(key => /token|live|profile|renderer|run_as_node/i.test(key)), false);
  assert.equal(selectedSpecs().length, 9);
  assert.deepEqual(selectedSpecs('screen'), ['tests/electron/screens.spec.ts', 'tests/electron/auto-screens.spec.ts']);
  assert.throws(() => selectedSpecs('../voice'));
});

test('profile preparation emits only allowed settings, never credentials or user note paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kirian-pc-preflight-'));
  await mkdir(join(root, 'runtime')); await mkdir(join(root, 'kirian-settings'));
  await writeFile(join(root, 'runtime/settings.json'), JSON.stringify({ schemaVersion: 1, host: {
    identity: { principal_id: 'PRIVATE_PERSON' }, speech: { api_key_env: 'PRIVATE_ENV_NAME' }, bindings: [
      { model: { provider_id: 'ollama', model_id: 'fixture' }, supports_images: true, boundary: 'local', api_key_env: 'PRIVATE_ENV_NAME' },
    ],
  } }));
  await writeFile(join(root, 'kirian-settings/note-folders-' + 'a'.repeat(64) + '.json'), JSON.stringify({ folders: [
    { kind: 'vault', path: 'PRIVATE_VAULT_PATH', label: 'PRIVATE_NOTE_TITLE', boundary: 'local', writeEnabled: false },
  ] }));
  const report = await profileSummary(root), json = JSON.stringify(report);
  assert.equal(json.includes('PRIVATE_'), false);
  assert.deepEqual(report.modelBindings, [{ provider: 'ollama', model: 'fixture', supportsImages: true, automaticAllowed: false, boundary: 'local' }]);
  assert.deepEqual(report.noteFolders, [{ kind: 'vault', boundary: 'local', writeEnabled: false }]);
  assert.equal(report.autoScreenUsesOffDefault, true);
  assert.equal(Object.keys(report.fingerprints).length, 2);
  assert.match(report.automaticMemoryAndRouting, /^not-read:/);
});
