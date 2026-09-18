import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const [current, upgrade, ...extra] = process.argv.slice(2);
if (!current || extra.length) throw new Error('사용법: node scripts/prepare-installer-sandbox.mjs 현재설치본.exe [테스트용새버전설치본.exe]');
const directory = join(desktop, '.test-output');
await mkdir(directory, { recursive: true });
const scratch = await mkdtemp(join(directory, 'installer-sandbox-'));
const input = join(scratch, 'input'), output = join(scratch, 'output');
await mkdir(input);
await mkdir(output);
await copyFile(resolve(current), join(input, 'current.exe'));
if (upgrade) await copyFile(resolve(upgrade), join(input, 'upgrade.exe'));
const runner = await readFile(join(desktop, 'tests/installer/windows-sandbox.ps1'), 'utf8');
// Sandbox의 Windows PowerShell 5.1도 한국어 문자열을 UTF-8로 읽도록 BOM을 붙인다.
await writeFile(join(input, 'verify.ps1'), '\uFEFF' + runner.replace(/^\uFEFF/, ''), 'utf8');
const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const config = `<Configuration>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <vGPU>Disable</vGPU>
  <MemoryInMB>4096</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>${escape(input)}</HostFolder><SandboxFolder>C:\\KirianSandboxInput</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${escape(output)}</HostFolder><SandboxFolder>C:\\KirianSandboxOutput</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\KirianSandboxInput\\verify.ps1</Command></LogonCommand>
</Configuration>
`;
await writeFile(join(scratch, 'verify.wsb'), config, 'utf8');
console.log(JSON.stringify({ configuration: join(scratch, 'verify.wsb'), output,
  hostInstallerExecuted: false, upgradeIncluded: Boolean(upgrade),
  note: '호스트 파일 공유는 복사한 설치본/검증 스크립트(읽기 전용)와 이 검증 결과 폴더로 제한됩니다.' }, null, 2));
