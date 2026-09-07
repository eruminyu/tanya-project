import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeScript = {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  remove: ReturnType<typeof vi.fn>;
};

let scripts: FakeScript[];
let rendererFactory: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("Live2DCubismCore", undefined);
  vi.stubEnv("VITE_LIVE2D_CORE_URL", "");
  scripts = [];
  vi.stubGlobal("document", {
    createElement: vi.fn(() => ({
      src: "", async: false, onload: null, onerror: null, remove: vi.fn(),
    })),
    head: { appendChild: vi.fn((script: FakeScript) => scripts.push(script)) },
  });
  rendererFactory = vi.fn(() => ({ createCubismStage: vi.fn() }));
  vi.doMock("./cubism-renderer", rendererFactory);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("./cubism-renderer");
});

describe("optional Live2D runtime", () => {
  it("모델이 비어 있으면 DOM과 Core 및 렌더러를 읽지 않는다", async () => {
    vi.stubGlobal("document", undefined);
    const { loadLive2DRenderer } = await import("./live2d-runtime");
    expect(await loadLive2DRenderer("  ")).toBeNull();
    expect(scripts).toHaveLength(0);
    expect(rendererFactory).not.toHaveBeenCalled();
  });

  it("Core 로딩을 공유하고 완료된 뒤에만 렌더러를 import한다", async () => {
    const { loadLive2DRenderer } = await import("./live2d-runtime");
    const first = loadLive2DRenderer("/model.model3.json");
    const second = loadLive2DRenderer("/model.model3.json");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe("/live2d/core/live2dcubismcore.min.js");
    expect(rendererFactory).not.toHaveBeenCalled();

    vi.stubGlobal("Live2DCubismCore", {});
    scripts[0].onload?.();
    const [firstRenderer, secondRenderer] = await Promise.all([first, second]);
    expect(firstRenderer?.createCubismStage).toBeTypeOf("function");
    expect(secondRenderer).toBe(firstRenderer);
    expect(rendererFactory).toHaveBeenCalledTimes(1);
  });

  it("설정한 Core URL을 사용한다", async () => {
    vi.stubEnv("VITE_LIVE2D_CORE_URL", " /local-sdk/core.js ");
    const { loadLive2DRenderer } = await import("./live2d-runtime");
    const loading = loadLive2DRenderer("/model.model3.json");
    expect(scripts[0].src).toBe("/local-sdk/core.js");
    vi.stubGlobal("Live2DCubismCore", {});
    scripts[0].onload?.();
    await loading;
  });

  it("Core가 이미 존재하면 스크립트를 중복 요청하지 않는다", async () => {
    vi.stubGlobal("Live2DCubismCore", {});
    const { loadLive2DRenderer } = await import("./live2d-runtime");
    expect((await loadLive2DRenderer("/model.model3.json"))?.createCubismStage).toBeTypeOf("function");
    expect(scripts).toHaveLength(0);
  });

  it("Core 요청 실패 시 렌더러를 읽지 않고 다음 요청을 허용한다", async () => {
    const { loadLive2DRenderer } = await import("./live2d-runtime");
    const first = loadLive2DRenderer("/model.model3.json");
    const failure = expect(first).rejects.toThrow("Cubism Core를 불러오지 못했습니다");
    scripts[0].onerror?.();
    await failure;
    expect(rendererFactory).not.toHaveBeenCalled();
    expect(scripts[0].remove).toHaveBeenCalledOnce();

    const retry = loadLive2DRenderer("/model.model3.json");
    expect(scripts).toHaveLength(2);
    vi.stubGlobal("Live2DCubismCore", {});
    scripts[1].onload?.();
    await retry;
  });

  it("스크립트 응답에 Core가 없으면 렌더러를 읽지 않는다", async () => {
    const { loadLive2DRenderer } = await import("./live2d-runtime");
    const loading = loadLive2DRenderer("/model.model3.json");
    const failure = expect(loading).rejects.toThrow("Cubism Core를 찾을 수 없습니다");
    scripts[0].onload?.();
    await failure;
    expect(rendererFactory).not.toHaveBeenCalled();
  });

  it("Core 요청이 끝나지 않으면 시간 초과로 실패한다", async () => {
    const { loadLive2DRenderer } = await import("./live2d-runtime");
    const loading = loadLive2DRenderer("/model.model3.json");
    const failure = expect(loading).rejects.toThrow("로딩 시간이 초과되었습니다");
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    expect(rendererFactory).not.toHaveBeenCalled();
    expect(scripts[0].remove).toHaveBeenCalledOnce();
  });

  it("렌더러 지연 import 실패를 호출자에게 전달한다", async () => {
    vi.stubGlobal("Live2DCubismCore", {});
    vi.doMock("./cubism-renderer", () => { throw new Error("renderer unavailable"); });
    const { loadLive2DRenderer } = await import("./live2d-runtime");
    await expect(loadLive2DRenderer("/model.model3.json")).rejects.toThrow();
    expect(scripts).toHaveLength(0);
  });
});
