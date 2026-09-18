import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const groups = {
  appearance: ['pc-appearance.spec.ts'],
  diagnostics: ['pc-appearance.spec.ts', 'pc-window-diagnostics.spec.ts', 'window-usability.spec.ts'],
  screen: ['screens.spec.ts', 'auto-screens.spec.ts'],
  'memory-notes': ['auto-memory.spec.ts', 'note-folders.spec.ts', 'note-editing.spec.ts'],
  window: ['desktop.spec.ts', 'window-usability.spec.ts'],
};
export function selectedSpecs(group = 'all') {
  if (group !== 'all' && !Object.hasOwn(groups, group)) throw Error('Unknown feature group');
  return [...new Set(group === 'all' ? Object.values(groups).flat() : groups[group])].map(name => `tests/electron/${name}`);
}
export function testEnvironment(source, { executable, python }) {
  // Never inherit a live model endpoint, token, renderer URL or user test profile.
  const env = Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined
    && !/^(KIRIAN_|TANYA_|ELECTRON_RUN_AS_NODE$)/i.test(key)));
  if (executable) env.KIRIAN_PACKAGED_EXE = executable;
  env.KIRIAN_PYTHON = python;
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.PYTHONPATH = resolve(desktopRoot, '../contracts/python');
  return env;
}
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}
async function names(path) {
  try { return await readdir(path); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function jsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function profileSummary(root) {
  // Only allowlisted settings are read. No note bodies, credentials, tokens or DB content.
  const runtime = await jsonFile(join(root, 'runtime/settings.json'));
  const host = runtime?.host;
  const autoFiles = (await names(join(root, 'auto-screen'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  const auto = await Promise.all(autoFiles.map(name => jsonFile(join(root, 'auto-screen', name))));
  const noteFiles = (await names(join(root, 'kirian-settings'))).filter(name => /^note-folders-[a-f0-9]{64}\.json$/.test(name));
  const notes = await Promise.all(noteFiles.map(name => jsonFile(join(root, 'kirian-settings', name))));
  const settingsFiles = ['runtime/settings.json', ...autoFiles.map(name => 'auto-screen/' + name),
    ...noteFiles.map(name => 'kirian-settings/' + name)];
  const fingerprints = {};
  for (const relative of settingsFiles) {
    try { fingerprints[relative] = await hashFile(join(root, relative)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return {
    profileExists: (await names(root)).length > 0,
    runtimeConfigured: !!host,
    modelBindings: (host?.bindings ?? []).map(binding => ({
      provider: binding.model?.provider_id, model: binding.model?.model_id,
      supportsImages: binding.supports_images === true,
      automaticAllowed: binding.automatic_allowed === true,
      boundary: binding.boundary,
    })),
    embeddingConfigured: !!host?.embedding,
    autoScreen: auto.map(value => ({ enabled: value?.settings?.enabled === true,
      analysisEnabled: value?.settings?.analysisEnabled === true, targets: value?.settings?.targets?.length ?? 0 })),
    autoScreenUsesOffDefault: autoFiles.length === 0,
    noteFolders: notes.flatMap(value => (value?.folders ?? []).map(folder => ({
      kind: folder.kind, boundary: folder.boundary, writeEnabled: folder.writeEnabled === true,
    }))),
    automaticMemoryAndRouting: 'not-read: databases may be in use; no state inferred',
    fingerprints,
  };
}
async function inspectPackage(executable) {
  const archive = join(dirname(executable), 'resources/app.asar');
  const manifest = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  const files = listPackage(archive).map(path => path.replaceAll('\\', '/'));
  const main = extractFile(archive, 'dist-electron/main.cjs');
  return { executable, exeSha256: await hashFile(executable), archiveSha256: await hashFile(archive),
    packageName: manifest.name, version: manifest.version,
    mainSha256: hashBytes(main),
    live2d: { modelManifest: files.some(path => /\/live2d\/.*\.model3\.json$/.test(path)),
      modelBinary: files.some(path => /\/live2d\/.*\.moc3$/.test(path)),
      texture: files.some(path => /\/live2d\/.*\.png$/.test(path)),
      licenses: files.some(path => path.startsWith('/dist/licenses/')) },
  };
}
async function invoke(args, env, logFile) {
  const chunks = [];
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: desktopRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', reject);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { chunks.push(data); process.stdout.write(data); });
    child.on('close', code => done(code ?? 1));
  });
  await writeFile(logFile, Buffer.concat(chunks));
  return code;
}
export async function main(argv = process.argv.slice(2)) {
  const options = { group: 'all', grep: null, run: false, executable: null,
    python: resolve(desktopRoot, '../../.venv/Scripts/python.exe'),
    profile: process.env.APPDATA ? join(process.env.APPDATA, 'Kirian') : null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--run-gui') options.run = true;
    else if (arg === '--prepare') continue;
    else if (['--exe', '--python', '--profile-root', '--group', '--grep'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw Error('Missing option value');
      options[{'--exe':'executable','--python':'python','--profile-root':'profile','--group':'group','--grep':'grep'}[arg]] = ['--group','--grep'].includes(arg) ? value : resolve(value);
    } else throw Error('Usage: node scripts/verify-pc-features.mjs [--prepare|--run-gui] [--exe path] [--python path] [--profile-root path] [--group all|screen|memory-notes|window|appearance|diagnostics] [--grep regex]');
  }
  const specs = selectedSpecs(options.group);
  await mkdir(join(desktopRoot, '.test-output'), { recursive: true });
  const output = await mkdtemp(join(desktopRoot, '.test-output/pc-features-'));
  const report = { mode: options.run ? 'gui' : 'prepare', startedAt: new Date().toISOString(),
    group: options.group, grep: options.grep, specs, blockers: [],
    requiredSlot: 'Exclusive display, Electron/Live2D rendering and Ctrl+Alt+T; allow about 10 minutes for all groups.',
    boundaries: ['Each spec creates a synthetic profile and vault.', 'Only owned fixture windows are captured.',
      'Model responses use localhost HTTP fixtures; no Ollama, microphone, voice or external account.',
      'The actual user profile is read only for the summary and never passed to a test launch.'],
    humanChecks: ['Judge the Live2D appearance, clipping and legibility at normal desktop scale.',
      'Use a physical Ctrl+Alt+T press to recover the fixture window, and check real focus/click-through feel.',
      'Open only the generated fixture vault in Obsidian to judge simultaneous editing and conflict messages.',
      'Real model screen comprehension and semantic-memory quality need a separate model slot.'],
  };
  const inspect = async (name, action) => {
    try { report[name] = await action(); }
    catch (error) { report.blockers.push(`${name}: ${error.code ?? error.name}`); }
  };
  if (options.profile) await inspect('profileBefore', () => profileSummary(options.profile));
  await inspect('pythonAvailable', async () => { await access(options.python); return true; });
  if (options.executable) await inspect('package', () => inspectPackage(options.executable));
  else await inspect('developmentBuild', async () => ({ mainSha256: await hashFile(join(desktopRoot, 'dist-electron/main.cjs')) }));
  await inspect('worktreeScreenController', () => hashFile(join(desktopRoot, 'src/main/screens/auto-screen-controller.ts')));
  const env = testEnvironment(process.env, options);
  const playwright = join(desktopRoot, 'node_modules/@playwright/test/cli.js');
  // The opt-in live vision test is excluded even if someone adds a live environment variable.
  const args = [playwright, 'test', '-c', 'playwright.config.ts', ...specs, '--workers=1', '--output', join(output, 'playwright'),
    '--grep-invert', 'live selected Ollama vision model'];
  if (options.grep) args.push('--grep', options.grep);
  report.listExitCode = await invoke([...args, '--list'], env, join(output, 'test-list.log'));
  if (report.listExitCode !== 0) report.blockers.push('Playwright collection failed; see test-list.log');
  report.guiStarted = false;
  if (options.run && report.blockers.length === 0) {
    report.guiStarted = true;
    report.testExitCode = await invoke(args, env, join(output, 'gui.log'));
    if (options.profile) {
      await inspect('profileAfter', () => profileSummary(options.profile));
      report.profileSettingsUnchanged = JSON.stringify(report.profileBefore?.fingerprints) === JSON.stringify(report.profileAfter?.fingerprints);
    }
  }
  report.completedAt = new Date().toISOString();
  report.passed = options.run ? report.guiStarted && report.testExitCode === 0 && report.blockers.length === 0
    && report.profileSettingsUnchanged !== false : report.blockers.length === 0;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ mode: report.mode, passed: report.passed, guiStarted: report.guiStarted,
    report: join(output, 'report.json'), blockers: report.blockers }, null, 2));
  if (!report.passed) process.exitCode = 1;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
