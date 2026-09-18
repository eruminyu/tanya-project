// Ships the Live2D runtime, the profile's character and the preserved notices next to the Vite build.
// Profile `kirian` (default): the Kirian rig from packages/client. Profile `tanya`: the Live2D sample character
// (Mao by default, Hiyori optional) from packages/web/live2d-samples/<Name> (private repository only; Free Material License — excluded from the public snapshot) plus the
// app-authored emotion presets; the Kirian model is not copied at all in that profile.
import { access, copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const web = fileURLToPath(new URL('../', import.meta.url));
const client = fileURLToPath(new URL('../../client/', import.meta.url));
const desktop = fileURLToPath(new URL('../../desktop/', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const profile = process.env.VITE_WEB_PROFILE || 'kirian';
if (!['kirian', 'tanya'].includes(profile)) throw new Error('unknown_web_profile:' + profile);

const dist = join(web, 'dist');
await mkdir(join(dist, 'licenses'), { recursive: true });
await rm(join(dist, 'live2d'), { recursive: true, force: true });
for (const name of ['core', 'framework']) await cp(join(client, 'public', 'live2d', name), join(dist, 'live2d', name), { recursive: true });
await cp(join(client, 'model-licenses'), join(dist, 'licenses'), { recursive: true });
// speech-player.ts reuses AIRI's playback manager (MIT): the preserved license and provenance ship with the page.
await copyFile(join(desktop, 'src', 'vendor', 'airi-audio', 'LICENSE'), join(dist, 'licenses', 'airi-audio-MIT.txt'));
await copyFile(join(desktop, 'src', 'vendor', 'airi-audio', 'provenance.json'), join(dist, 'licenses', 'airi-audio-provenance.json'));

if (profile === 'kirian') {
  await cp(join(client, 'public', 'live2d', 'kirian'), join(dist, 'live2d', 'kirian'), { recursive: true });
} else {
  // The sample lives in the private repository (packages/web/live2d-samples, excluded from the public snapshot);
  // a Git-ignored .cache copy is accepted for machines that keep it outside the tree. The tanya profile currently
  // ships Mao; Hiyori stays available by setting WEB_SAMPLE_CHARACTER=hiyori (profile.ts must match).
  const character = process.env.WEB_SAMPLE_CHARACTER || 'mao';
  const samples = { mao: { dir: 'Mao', model: 'mao_pro', required: ['mao_pro.model3.json', 'mao_pro.moc3', 'mao_pro.physics3.json', 'mao_pro.pose3.json', 'mao_pro.2048/texture_00.png'] },
                    hiyori: { dir: 'Hiyori', model: 'Hiyori', required: ['Hiyori.model3.json', 'Hiyori.moc3', 'Hiyori.physics3.json'] } }[character];
  if (!samples) throw new Error('unknown_sample_character:' + character);
  let sample = join(web, 'live2d-samples', samples.dir);
  try { await access(join(sample, samples.required[0])); } catch { sample = join(root, '.cache', 'live2d-samples', samples.dir); }
  for (const required of samples.required) {
    try { await access(join(sample, required)); }
    catch { throw new Error(`Live2D sample character missing: ${join(sample, required)} — see packages/web/live2d-profiles/${character}/README.md`); }
  }
  await cp(sample, join(dist, 'live2d', character), { recursive: true });
  await cp(join(web, 'live2d-profiles', character, 'emotions'), join(dist, 'live2d', character, 'emotions'), { recursive: true });
  await rm(join(dist, 'licenses', 'kirian-model-provenance.md'), { force: true });
}
await copyFile(join(web, 'notices', profile + '.html'), join(dist, 'notices.html'));
console.log(`Prepared web build for profile "${profile}": Live2D runtime, character (${profile === 'kirian' ? 'Kirian rig' : 'Live2D sample ' + (process.env.WEB_SAMPLE_CHARACTER || 'mao')}), notices (Live2D, AIRI MIT${profile === 'kirian' ? ', Kirian model' : ''}).`);
