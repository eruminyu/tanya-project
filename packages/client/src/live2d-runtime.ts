type CubismRenderer = typeof import("./cubism-renderer");

const DEFAULT_CORE_URL = "/live2d/core/live2dcubismcore.min.js";
const CORE_LOAD_TIMEOUT_MS = 15_000;
const coreLoads = new Map<string, Promise<void>>();
let rendererLoad: Promise<CubismRenderer> | undefined;

function hasCubismCore(): boolean {
  return Boolean((globalThis as { Live2DCubismCore?: unknown }).Live2DCubismCore);
}

async function loadCubismCore(coreUrl: string): Promise<void> {
  if (hasCubismCore()) return;
  const pending = coreLoads.get(coreUrl);
  if (pending) return pending;
  if (typeof document === "undefined") {
    throw new Error("Live2D 렌더링에는 브라우저가 필요합니다.");
  }

  const load = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = coreUrl;
    script.async = true;

    const finish = (error?: Error) => {
      clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      if (error) {
        script.remove();
        reject(error);
      } else {
        resolve();
      }
    };
    const timeout = setTimeout(() => finish(new Error(
      "Cubism Core 로딩 시간이 초과되었습니다. SDK 설치와 Core 경로를 확인해 주세요.",
    )), CORE_LOAD_TIMEOUT_MS);

    script.onload = () => finish(hasCubismCore() ? undefined : new Error(
      "Cubism Core를 찾을 수 없습니다. 호환되는 공식 SDK의 Core 파일이 필요합니다.",
    ));
    script.onerror = () => finish(new Error(
      "Cubism Core를 불러오지 못했습니다. SDK 설치와 Core 경로를 확인해 주세요.",
    ));
    try {
      document.head.appendChild(script);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });

  coreLoads.set(coreUrl, load);
  void load.catch(() => {
    if (coreLoads.get(coreUrl) === load) coreLoads.delete(coreUrl);
  });
  return load;
}

export async function loadLive2DRenderer(
  modelUrl: string,
  coreUrl: string = import.meta.env.VITE_LIVE2D_CORE_URL?.trim() || DEFAULT_CORE_URL,
): Promise<CubismRenderer | null> {
  if (!modelUrl.trim()) return null;
  await loadCubismCore(coreUrl.trim() || DEFAULT_CORE_URL);
  // Framework modules access the Core global during evaluation.
  if (!rendererLoad) {
    const loading = import("./cubism-renderer");
    rendererLoad = loading;
    void loading.catch(() => {
      if (rendererLoad === loading) rendererLoad = undefined;
    });
  }
  return rendererLoad;
}
