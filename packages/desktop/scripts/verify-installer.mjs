import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const desktop = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2) throw new Error('사용법: node scripts/verify-installer.mjs 설치본.exe [비교할-win-unpacked-폴더]');
const installer = resolve(args[0]);
const original = args[1] ? resolve(args[1]) : undefined;
const sevenZip = process.env.KIRIAN_7ZIP_EXE || join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip/7z.exe');
await access(sevenZip);
await access(installer);
await mkdir(join(desktop, '.test-output'), { recursive: true });
const scratch = await mkdtemp(join(desktop, '.test-output/installer-extract-'));

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), '설치본에 링크가 포함되어 있습니다.');
    if (entry.isDirectory()) result.push(...await files(location));
    else if (entry.isFile()) result.push(location);
  }
  return result;
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function unpack(archive, target) {
  await run(sevenZip, ['x', '-y', `-o${target}`, archive], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

// 설치 EXE를 실행하지 않는다. 실제 내장 payload를 추출해 패키지 누락을 검사한다.
const outer = join(scratch, 'container'), app = join(scratch, 'app');
await unpack(installer, outer);
const payloads = (await files(outer)).filter((file) => /app-64\.7z$/i.test(file));
assert.equal(payloads.length, 1, 'x64 NSIS payload 한 개가 필요합니다.');
await unpack(payloads[0], app);
for (const path of ['Kirian.exe', 'resources/app.asar', 'resources/brain/kirian-brain.exe',
  'resources/brain/_internal/base_library.zip', 'resources/brain/_internal/python312.dll',
  'resources/brain/_internal/kirian_contracts/schema/protocol.v1.json',
  'resources/brain/_internal/licenses/THIRD_PARTY_LICENSES.txt']) await access(join(app, path));
let comparedFiles = 0;
if (original) {
  const expected = (await files(original)).map((file) => relative(original, file)).sort();
  const actual = (await files(app)).map((file) => relative(app, file)).sort();
  // NSIS는 payload 내부에 elevate/uninstaller 파일을 추가할 수 있다.
  for (const path of expected) {
    assert.ok(actual.includes(path), '설치본 누락: ' + path);
    assert.equal(await digest(join(original, path)), await digest(join(app, path)), '설치본 불일치: ' + path);
    comparedFiles += 1;
  }
}
const report = {
  installer, sha256: await digest(installer), extractedApp: app, comparedFiles,
  result: 'payload-verified', installerExecuted: false,
  remaining: '실제 Windows 설치·새 버전 업데이트·제거 시 appData 보존은 별도 격리 Windows에서 확인해야 합니다.',
};
await writeFile(join(scratch, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
