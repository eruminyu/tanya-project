import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const python = process.env.KIRIAN_BRAIN_BUILD_PYTHON
  ? resolve(process.env.KIRIAN_BRAIN_BUILD_PYTHON)
  : join(repo, '.cache/brain-build-venv/Scripts/python.exe');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Brain 패키징은 Windows x64에서 실행해야 합니다.');
}
try { await access(python); }
catch {
  throw new Error('Brain 빌드 환경이 없습니다. 저장소 루트에서 python -m venv .cache/brain-build-venv 후 해당 Python으로 -m pip install -r packages/brain/requirements-desktop-build.txt 를 실행하세요.');
}
const child = spawn(python, ['-m', 'PyInstaller', '--noconfirm', '--clean',
  '--distpath', join(repo, '.cache/brain-bundle'),
  '--workpath', join(repo, '.cache/brain-pyinstaller'),
  join(repo, 'packages/desktop/packaging/brain.spec')], {
  cwd: repo, stdio: 'inherit', shell: false, windowsHide: true,
  env: { ...process.env, PYTHONPATH: '', PYTHONNOUSERSITE: '1',
    PYINSTALLER_CONFIG_DIR: join(repo, '.cache/brain-pyinstaller-cache') },
});
child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });
