import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  stdin: { contents: `export * from './src/renderer/live2d/lifetime.ts'; export * from './src/renderer/live2d/parameters.ts'; export * from './src/renderer/live2d/cubism-layout.ts'; export * from './src/renderer/live2d/live2d-model.ts';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
});
const { StageLifetime, abortable, playbackMouth, safeGaze, safeFraming, calculateCanvasSize, calculateProjectionTransform, kirianManifest } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const modelRoot = new URL('../../client/public/live2d/kirian/', import.meta.url);
const expectedRuntimeHashes = {
  'Kirian_UpperBody_Rig_v001.moc3': 'c85e60f6f5f8c53da87162bd9800b311aba02953c703bcee6c0171c121720046',
  'Kirian_UpperBody_Rig_v001.model3.json': 'de6b7a2957cba0f3ed149fdd51c8f7c2cd19e0a53537b478f3cb54e645cfee5d',
  'Kirian_UpperBody_Rig_v001.physics3.json': '8921dd0baa2e7016be1cdfac49ee507528c3d928c890d0d35dde0e1e2120548d',
  'Kirian_UpperBody_Rig_v001.cdi3.json': 'a3d57c694ea0b6bdc5acebd430be0972913487c3031d03c5a368b1c8234458e6',
  'Kirian_UpperBody_Rig_v001.4096/texture_00.png': '06da9fc573e2145f9d2912b33fd354c6978608d16a643311597fb561a6ef60d9',
  'motions/Rig_Check_Loop.motion3.json': '5c55b8582b0c80fec30220f79dc73f3067125888b8c0db8179c20b9c7e0e979c',
};

test('aborting a loading stage releases acquired resources once, in reverse order', () => {
  const lifetime = new StageLifetime(), released = [];
  lifetime.add(() => released.push('framework'));
  lifetime.add(() => { released.push('model'); throw new Error('lost context'); });
  lifetime.add(() => released.push('texture'));
  lifetime.dispose();
  lifetime.dispose();
  assert.deepEqual(released, ['texture', 'model', 'framework']);
  assert.throws(() => lifetime.check(), { name: 'AbortError' });
});

test('an asset that finishes after disposal is released immediately', () => {
  const lifetime = new StageLifetime();
  lifetime.dispose();
  let released = 0;
  lifetime.add(() => released++);
  assert.equal(released, 1);
});

test('aborted Core wait rejects while another mount can still finish the shared load', async () => {
  const first = new AbortController(), second = new AbortController();
  let finish;
  const shared = new Promise(resolve => { finish = resolve; });
  const cancelled = abortable(shared, first.signal);
  const successful = abortable(shared, second.signal);
  first.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  finish('loaded');
  assert.equal(await successful, 'loaded');
});

test('mouth is closed immediately outside actual playback and invalid levels cannot reach Cubism', () => {
  assert.equal(playbackMouth(0.8, true), 0.8);
  assert.equal(playbackMouth(0.8, false), 0);
  for (const input of [NaN, Infinity, -Infinity, -1]) assert.equal(playbackMouth(input, true), 0);
  assert.equal(playbackMouth(20, true), 1);
});

test('gaze and framing reject nonfinite values and do not retain caller objects', () => {
  const gaze = { x: NaN, y: 4 }, safe = safeGaze(gaze);
  gaze.y = 0;
  assert.deepEqual(safe, { x: 0, y: 1 });
  assert.deepEqual(safeFraming({ scale: Infinity, offsetX: -9, offsetY: NaN }), { scale: 3, offsetX: -2.5, offsetY: -2 });
});

test('canvas resize caps pixel density and avoids zero-size graphics buffers', () => {
  assert.deepEqual(calculateCanvasSize(200, 100, 3), { width: 400, height: 200 });
  assert.deepEqual(calculateCanvasSize(0, 0, 1), { width: 1, height: 1 });
});

test('default Kirian model points at the verified upper-body runtime package', async () => {
  assert.equal(kirianManifest.id, 'kirian-upperbody-v001');
  assert.equal(kirianManifest.modelUrl, '/live2d/kirian/Kirian_UpperBody_Rig_v001.model3.json');
  assert.deepEqual(kirianManifest.layout, { defaultScale: 0.55, defaultOffsetX: 0, defaultOffsetY: 1.2 });

  const setting = JSON.parse(await readFile(new URL('Kirian_UpperBody_Rig_v001.model3.json', modelRoot), 'utf8'));
  const references = [
    setting.FileReferences.Moc,
    ...setting.FileReferences.Textures,
    setting.FileReferences.Physics,
    setting.FileReferences.DisplayInfo,
    ...Object.values(setting.FileReferences.Motions).flat().map(motion => motion.File),
  ];
  assert.deepEqual(
    new Set(references),
    new Set(Object.keys(expectedRuntimeHashes).filter(relativePath => !relativePath.endsWith('.model3.json'))),
  );
  for (const [relativePath, expected] of Object.entries(expectedRuntimeHashes)) {
    const bytes = await readFile(new URL(relativePath, modelRoot));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, relativePath);
  }
});

test('height-fit layouts keep the vertical framing identical across canvas aspect ratios', () => {
  const framing = { scale: 3, offsetX: 0, offsetY: -2 };
  const fit = { defaultScale: 2 / 3, defaultOffsetX: 0, defaultOffsetY: 1, fit: 'height' };
  const wide = calculateProjectionTransform(1600, 900, 2400, framing, fit);
  const square = calculateProjectionTransform(900, 900, 2400, framing, fit);
  const tall = calculateProjectionTransform(400, 900, 2400, framing, fit);
  for (const transform of [wide, square, tall]) {
    assert.ok(Math.abs(transform.y - 2) < 1e-9, 'vertical scale is the framing scale on a height basis');
    assert.ok(Math.abs(transform.offsetY + 1) < 1e-9, 'vertical offset does not depend on the aspect');
  }
  assert.ok(Math.abs(wide.x - 2 * 900 / 1600) < 1e-9 && Math.abs(tall.x - 2 * 900 / 400) < 1e-9, 'horizontal scale keeps the model proportions');
  // The default (auto) basis is unchanged: portrait canvases fit the width, landscape canvases fit the height.
  const auto = { defaultScale: 1, defaultOffsetX: 0, defaultOffsetY: 0 };
  assert.deepEqual(calculateProjectionTransform(400, 900, 2400, { scale: 1, offsetX: 0, offsetY: 0 }, auto), { x: 1, y: 400 / 900, offsetX: 0, offsetY: 0 });
  assert.deepEqual(calculateProjectionTransform(1600, 900, 2400, { scale: 1, offsetX: 0, offsetY: 0 }, auto), { x: 900 / 1600, y: 1, offsetX: 0, offsetY: 0 });
});
