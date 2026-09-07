import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Live2DStage } from "./Live2DStage";
import { createLive2DManifest } from "./live2d-model";
import { DEFAULT_LIVE2D_FRAMING } from "./live2d-framing";

// Importing the renderer before Core is available would break the entire app.
vi.mock("./cubism-renderer", () => { throw new Error("Core is not installed"); });

describe("Live2DStage without bundled assets", () => {
  it("모델 없는 SSR에서 안내와 나머지 UI를 유지하고 canvas를 만들지 않는다", () => {
    const html = renderToStaticMarkup(
      <main>
        <Live2DStage
          emotion="neutral" mouthOpen={0} gaze={{ x: 0, y: 0 }}
          framing={DEFAULT_LIVE2D_FRAMING} manifest={createLive2DManifest("")}
        />
        <button>채팅</button><button>튜토리얼</button><button>승인</button>
      </main>,
    );
    expect(html).toContain("Live2D 모델 미설치");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<canvas");
    expect(html).toContain("<button>채팅</button>");
    expect(html).toContain("<button>튜토리얼</button>");
    expect(html).toContain("<button>승인</button>");
  });

  it("설정된 모델도 서버 렌더링 중에는 Core나 렌더러를 import하지 않는다", () => {
    const html = renderToStaticMarkup(
      <Live2DStage
        emotion="neutral" mouthOpen={0} gaze={{ x: 0, y: 0 }}
        framing={DEFAULT_LIVE2D_FRAMING} manifest={createLive2DManifest("/local/model.model3.json")}
      />,
    );
    expect(html).toContain("<canvas");
    expect(html).toContain("Live2D 모델 불러오는 중");
  });
});
