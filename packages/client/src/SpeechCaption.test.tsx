import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpeechCaption } from "./SpeechCaption";

const visibleCaption = {
  captionsEnabled: true,
  chatPanelOpen: false,
  speaking: true,
  text: "타냐가 말하는 내용",
};

describe("발화 자막", () => {
  it("표시 조건을 만족하면 접근 가능한 상태 영역으로 렌더한다", () => {
    const html = renderToStaticMarkup(<SpeechCaption {...visibleCaption} />);

    expect(html).toContain('class="speech-caption"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('style="pointer-events:none"');
    expect(html).toContain("타냐가 말하는 내용");
  });

  it("텍스트는 클램프를 담당하는 안쪽 요소에 담긴다 (T-009)", () => {
    const html = renderToStaticMarkup(<SpeechCaption {...visibleCaption} />);

    // 바깥 요소가 padding을, 안쪽 요소가 line-clamp·overflow를 가져야
    // 넘친 3번째 줄이 padding 영역에 잘린 채 노출되지 않는다.
    expect(html).toContain('<span class="speech-caption-text">타냐가 말하는 내용</span>');
  });

  it("표시 조건을 만족하지 않으면 아무것도 렌더하지 않는다", () => {
    const html = renderToStaticMarkup(
      <SpeechCaption {...visibleCaption} chatPanelOpen />,
    );

    expect(html).toBe("");
  });
});

describe("선제 발화 자막 (T-014)", () => {
  it("대화창이 닫힌 채 말하면 자막이 뜬다", () => {
    const html = renderToStaticMarkup(
      <SpeechCaption captionsEnabled chatPanelOpen={false} speaking text="3시에 회의 있어" />,
    );

    expect(html).toContain("3시에 회의 있어");
  });

  it("선제 제안이 대화창을 열면 자막이 사라진다 — 열지 않아야 하는 이유", () => {
    const html = renderToStaticMarkup(
      <SpeechCaption captionsEnabled chatPanelOpen speaking text="3시에 회의 있어" />,
    );

    expect(html).toBe("");
  });
});
