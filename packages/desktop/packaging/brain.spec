# PyInstaller onedir: 실행 파일과 _internal 전체가 하나의 배포 단위다.
import importlib.metadata
import hashlib
import json
from pathlib import Path
import platform
import sys

from PyInstaller.utils.hooks import collect_data_files

repo = Path(SPECPATH).resolve().parents[2]
requirements = repo / "packages/brain/requirements-desktop-build.txt"
if sys.version_info[:2] != (3, 12) or platform.machine().lower() not in ("amd64", "x86_64"):
    raise RuntimeError("Frozen Brain requires CPython 3.12 x64")

notices = ["Kirian에 포함된 Python 런타임·라이브러리와 빌드 도구의 라이선스 고지\n"]
versions = {}
for line in requirements.read_text(encoding="utf-8").splitlines():
    if not line or line.startswith("#"):
        continue
    name, pinned = line.split("==")
    distribution = importlib.metadata.distribution(name)
    if distribution.version != pinned:
        raise RuntimeError(f"Pinned build dependency mismatch: {name}")
    versions[name] = pinned
    notices.append(f"\n{'=' * 72}\n{name} {pinned}\n")
    licenses = [file for file in distribution.files or []
                if file.name.lower().startswith(("license", "copying", "notice"))
                and file.suffix.lower() not in (".py", ".pyc", ".pyd")]
    if not licenses:
        raise RuntimeError(f"Missing dependency license text: {name}")
    for item in sorted(licenses):
        location = distribution.locate_file(item)
        if location.is_file():
            notices.append(f"\n{item.name}\n{location.read_text(encoding='utf-8', errors='replace')}\n")

python_license = Path(sys.base_prefix) / "LICENSE.txt"
if not python_license.is_file():
    python_license = Path(sys.base_prefix) / "LICENSE"
if not python_license.is_file():
    raise RuntimeError("Missing Python runtime license")
notices.append(f"\n{'=' * 72}\nPython {platform.python_version()}\n{python_license.read_text(encoding='utf-8')}\n")
native_root = Path(SPECPATH) / "licenses"
native_provenance = json.loads((native_root / "provenance.json").read_text(encoding="utf-8-sig"))
for entry in native_provenance["files"]:
    license_bytes = (native_root / entry["file"]).read_bytes()
    if hashlib.sha256(license_bytes).hexdigest() != entry["sha256"]:
        raise RuntimeError("Native license content mismatch")
    notices.append(f"\n{'=' * 72}\n{entry['file']}\n{entry['source']}\n{license_bytes.decode('utf-8')}\n")
generated = repo / ".cache/brain-notices"
generated.mkdir(parents=True, exist_ok=True)
(generated / "THIRD_PARTY_LICENSES.txt").write_text("\n".join(notices), encoding="utf-8")
(generated / "build-versions.json").write_text(json.dumps({"python": platform.python_version(), "dependencies": versions}, indent=2) + "\n", encoding="utf-8")

datas = [
    (str(repo / "packages/contracts/schema/protocol.v1.json"), "kirian_contracts/schema"),
    (str(generated / "THIRD_PARTY_LICENSES.txt"), "licenses"),
    (str(generated / "build-versions.json"), "licenses"),
    (str(native_root / "provenance.json"), "licenses/native"),
]
datas += collect_data_files("jsonschema_specifications")
analysis = Analysis(
    [str(repo / "packages/brain/rearchitecture/desktop_entry.py")],
    pathex=[str(repo / "packages/brain"), str(repo / "packages/contracts/python")],
    binaries=[], datas=datas,
    hiddenimports=["uvicorn.logging", "uvicorn.loops.asyncio", "uvicorn.protocols.http.h11_impl",
                   "uvicorn.protocols.websockets.websockets_impl", "uvicorn.lifespan.on"],
    hookspath=[], hooksconfig={}, runtime_hooks=[],
    excludes=["pytest", "tkinter", "unittest"], noarchive=False,
)
archive = PYZ(analysis.pure)
executable = EXE(archive, analysis.scripts, [], exclude_binaries=True, name="kirian-brain",
                 debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
                 console=True, disable_windowed_traceback=True, contents_directory="_internal")
bundle = COLLECT(executable, analysis.binaries, analysis.datas, strip=False, upx=False, name="kirian-brain")
