import { abortable } from './lifetime.js';
import { localAssetUrl } from './assets.js';

let loading: Promise<void> | undefined;

function hasCore(): boolean {
  const core: unknown = Reflect.get(globalThis, 'Live2DCubismCore');
  return typeof core === 'object' && core !== null && 'Version' in core;
}

/** Shared Core script is independent of a single model's mount/unmount. */
export async function loadCubismCore(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (hasCore()) return;
  if (!loading) {
    const pending = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      let finished = false;
      const finish = (success: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        script.onload = null;
        script.onerror = null;
        if (success) resolve();
        else {
          script.remove();
          reject(new Error('캐릭터 실행 모듈을 불러오지 못했어요.'));
        }
      };
      const timer = window.setTimeout(() => finish(false), 15000);
      script.src = localAssetUrl('/live2d/core/live2dcubismcore.min.js');
      script.async = true;
      script.onload = () => finish(hasCore());
      script.onerror = () => finish(false);
      document.head.append(script);
    });
    loading = pending;
    void pending.catch(() => { if (loading === pending) loading = undefined; });
  }
  await abortable(loading, signal);
}
