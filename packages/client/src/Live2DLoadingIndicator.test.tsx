import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Live2DLoadingIndicator } from "./Live2DLoadingIndicator";

describe("Live2D 첫 로딩 안내", () => {
  it("화면을 막지 않는 상태 영역과 접근 가능한 진행률을 제공한다", () => {
    const html = renderToStaticMarkup(
      <Live2DLoadingIndicator progress={{ percent: 63, message: "모델 이미지 3/4 불러오는 중" }} />,
    );

    expect(html).toContain('class="model-loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="63"');
    expect(html).toContain('style="width:63%"');
    expect(html).toContain("모델 이미지 3/4 불러오는 중");
    expect(html).toContain("첫 방문은 모델 파일을 내려받느라 조금 시간이 걸릴 수 있어요.");
  });
});
