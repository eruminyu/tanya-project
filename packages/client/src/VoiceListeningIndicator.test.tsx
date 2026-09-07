import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VoiceListeningIndicator } from "./VoiceListeningIndicator";

describe("듣는 중 표시", () => {
  it("짧은 상태 문구와 장식용 5단 파형을 표시한다", () => {
    const html = renderToStaticMarkup(<VoiceListeningIndicator />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="타냐가 듣고 있어요"');
    expect(html).toContain("듣고 있어");
    expect(html.match(/<i><\/i>/g)).toHaveLength(5);
  });
});
