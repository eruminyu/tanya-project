import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const desktop = fileURLToPath(new URL('../', import.meta.url));
const compiler = process.env.KIRIAN_NSIS_COMPILER;

test('NSIS 실제 경로 가드: appData 동일·상위·하위·정규화 경계 차단',
  { skip: !compiler, timeout: 60000 }, async () => {
    await mkdir(join(desktop, '.test-output'), { recursive: true });
    const directory = await mkdtemp(join(desktop, '.test-output/nsis-guard-'));
    const include = join(desktop, 'packaging/installer.nsh');
    const cases = [
      ['$APPDATA\\Kirian', 2], ['$APPDATA', 2], ['$APPDATA\\Kirian\\brain', 2],
      ['$APPDATA\\other\\..\\Kirian\\', 2], ['$APPDATA\\kIrIaN', 2],
      ['$LOCALAPPDATA\\Programs\\Kirian', 0], ['$APPDATA\\Kirian-other', 2],
      ['$LOCALAPPDATA\\Programs\\${APP_FILENAME}', 0],
    ];
    try {
      for (let index = 0; index < cases.length; index += 1) {
        const [path, expected] = cases[index];
        const executable = join(directory, `probe-${index}.exe`);
        const source = join(directory, `probe-${index}.nsi`);
        // 이 독립 실행 파일은 경로 비교 후 종료 코드만 반환한다.
        // 제품 설치 코드·레지스트리 쓰기·파일 삭제/쓰기 섹션은 포함하지 않는다.
        await writeFile(source, `Unicode true\n!define APP_FILENAME "Kirian"\n!include "${include}"\nName "Kirian path guard probe"\nOutFile "${executable}"\nRequestExecutionLevel user\nSilentInstall silent\nSection\nSetShellVarContext current\nStrCpy $INSTDIR "${path}"\n!insertmacro rejectUserDataOverlap\nSetErrorLevel 0\nSectionEnd\n`);
        await run(compiler, ['/V2', source], { windowsHide: true });
        const code = await run(executable, [], { windowsHide: true }).then(() => 0, (error) => error.code);
        assert.equal(code, expected, path);
      }
      const target = join(directory, 'fixture-data'), alias = join(directory, 'fixture-alias');
      await mkdir(target);
      await symlink(target, alias, 'junction');
      const aliases = [[target, 0], [alias, 2], [join(alias, 'missing/nested'), 2]];
      for (let index = 0; index < aliases.length; index += 1) {
        const [path, expected] = aliases[index];
        const executable = join(directory, `junction-${index}.exe`), source = join(directory, `junction-${index}.nsi`);
        await writeFile(source, `Unicode true\n!include "${include}"\nName "Kirian reparse guard probe"\nOutFile "${executable}"\nRequestExecutionLevel user\nSilentInstall silent\nSection\nPush "${path}"\nCall kirianRejectReparseAncestors\nSetErrorLevel 0\nSectionEnd\n`);
        await run(compiler, ['/V2', source], { windowsHide: true });
        const code = await run(executable, [], { windowsHide: true }).then(() => 0, (error) => error.code);
        assert.equal(code, expected, path);
      }
      const cleanTree = join(directory, 'clean-tree'), linkedTree = join(directory, 'linked-tree');
      await mkdir(join(cleanTree, 'nested'), { recursive: true });
      await writeFile(join(cleanTree, 'nested/file.txt'), 'test fixture');
      await mkdir(linkedTree);
      await symlink(target, join(linkedTree, 'child-link'), 'junction');
      const trees = [[cleanTree, 0], [linkedTree, 2], [join(directory, 'not-yet-installed'), 0]];
      for (let index = 0; index < trees.length; index += 1) {
        const [path, expected] = trees[index];
        const executable = join(directory, `tree-${index}.exe`), source = join(directory, `tree-${index}.nsi`);
        await writeFile(source, `Unicode true\n!include "${include}"\nName "Kirian installation tree guard probe"\nOutFile "${executable}"\nRequestExecutionLevel user\nSilentInstall silent\nSection\nPush "${path}"\nCall kirianRejectReparseTree\nSetErrorLevel 0\nSectionEnd\n`);
        await run(compiler, ['/V2', source], { windowsHide: true });
        const code = await run(executable, [], { windowsHide: true }).then(() => 0, (error) => error.code);
        assert.equal(code, expected, path);
      }
    } finally {
      const checked = resolve(directory);
      assert.ok(checked.startsWith(resolve(desktop, '.test-output') + '\\'));
      await rm(checked, { recursive: true, force: true });
    }
  });
