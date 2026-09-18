"""Windows 부모 핸들을 고정해 파이프 상속·PID 재사용과 별개로 종료를 감지한다."""
import ctypes
from ctypes import wintypes
import os


class ParentProcess:
    def __init__(self):
        self.handle = None
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.GetCurrentProcess.argtypes = []
        self.kernel.GetCurrentProcess.restype = wintypes.HANDLE
        self.kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        self.kernel.GetProcessTimes.restype = wintypes.BOOL
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.WaitForSingleObject.restype = wintypes.DWORD
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        # SYNCHRONIZE + QUERY_LIMITED_INFORMATION, 상속 금지.
        self.handle = self.kernel.OpenProcess(0x101000, False, os.getppid())
        if not self.handle:
            raise RuntimeError("parent_unavailable")
        try:
            if self._created(self.handle) > self._created(self.kernel.GetCurrentProcess()) or self.exited():
                raise RuntimeError("parent_unavailable")
        except BaseException:
            self.close()
            raise

    def _created(self, handle):
        creation, exit_time, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not self.kernel.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_time), ctypes.byref(kernel), ctypes.byref(user)):
            raise RuntimeError("parent_unavailable")
        return creation.dwHighDateTime << 32 | creation.dwLowDateTime

    def exited(self):
        if not self.handle:
            return True
        # 알 수 없는 실패도 부모 종료로 취급한다. 대기 중 handle을 닫지 않는다.
        return self.kernel.WaitForSingleObject(self.handle, 0) != 258

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
