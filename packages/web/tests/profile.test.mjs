// Build profiles of the public web demo: the private Kirian build (Kirian rig) and the portfolio Tanya build
// (Live2D sample character). Selection is a pure function of the profile name so both can be checked here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

const source = await readFile(new URL('../src/profile.ts', import.meta.url), 'utf8');
const stripped = source.replace(/from '\.\.\/\.\.\/desktop\/src\/renderer\/live2d\/live2d-model\.js'/, "from 'data:text/javascript,export const kirianManifest = { id: \"kirian-upperbody-v001\", displayName: \"키리안\", modelUrl: \"/live2d/kirian/Kirian_UpperBody_Rig_v001.model3.json\", expressions: {}, parameters: {}, layout: {} };'");
const { outputText } = transpileModule(stripped, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } });
const { resolveProfile, PROFILES, josa } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('kirian is the default profile and keeps the Kirian rig and name', () => {
  for (const value of [undefined, '', 'kirian']) {
    const profile = resolveProfile(value);
    assert.equal(profile.id, 'kirian');
    assert.equal(profile.brandName, '키리안');
    assert.equal(profile.manifest.id, 'kirian-upperbody-v001');
    assert.equal(profile.characterDir, 'kirian');
  }
});

test('tanya profile renames the demo and uses the Live2D sample character, never the Kirian rig', () => {
  const profile = resolveProfile('tanya');
  assert.equal(profile.brandName, '타냐');
  assert.equal(profile.manifest.id, 'tanya-mao-sample');
  assert.equal(profile.manifest.displayName, '타냐');
  assert.match(profile.manifest.modelUrl, /^\/live2d\/mao\/mao_pro\.model3\.json$/);
  assert.equal(profile.characterDir, 'mao');
  assert.ok(!JSON.stringify(profile).includes('kirian/'), 'no Kirian asset path may leak into the Tanya build');
  for (const emotion of ['neutral', 'happy', 'sad', 'excited', 'worried', 'annoyed', 'affectionate'])
    assert.match(profile.manifest.expressions[emotion], new RegExp(`^/live2d/mao/emotions/${emotion}\\.exp3\\.json$`));
  assert.deepEqual(Object.keys(profile.manifest.parameters).sort(), ['angleX', 'angleY', 'eyeBallX', 'eyeBallY', 'eyeLeftOpen', 'eyeRightOpen', 'mouthOpen']);
});

test('unknown profiles are rejected instead of silently falling back', () => {
  assert.throws(() => resolveProfile('shiroko'), /unknown_web_profile/);
  assert.deepEqual(Object.keys(PROFILES).sort(), ['kirian', 'tanya']);
});

test('korean particles follow the final consonant of the brand name', () => {
  assert.equal(josa('키리안', '이', '가'), '키리안이');
  assert.equal(josa('타냐', '이', '가'), '타냐가');
  assert.equal(josa('키리안', '과', '와'), '키리안과');
  assert.equal(josa('타냐', '과', '와'), '타냐와');
});
