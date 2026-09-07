import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrainConnectionPanel } from "./BrainConnectionPanel";
import type { BrainDiagnosis } from "./brain-url";

const noop = () => undefined;

function render(overrides: Partial<Parameters<typeof BrainConnectionPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <BrainConnectionPanel
      url="http://192.168.10.20:8098"
      busy={false}
      result={null}
      canReconnect
      onUrlChange={noop}
      onTest={noop}
      onReconnect={noop}
      {...overrides}
    />,
  );
}

describe("Brain 연결 및 진단 패널", () => {
  it("유효한 주소에서는 경고 없이 두 버튼을 쓸 수 있다", () => {
    const html = render();

    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("disabled");
    expect(html).toContain("연결 테스트");
    expect(html).toContain("지금 다시 연결");
  });

  it("잘못된 주소는 이유를 알리고 진단을 막는다", () => {
    const html = render({ url: "hello" });

    expect(html).toContain('role="alert"');
    expect(html).toContain("주소 형식이 올바르지 않습니다");
    expect(html).toContain("disabled");
  });

  it("스킴이 빠진 주소도 구체적으로 안내한다", () => {
    expect(render({ url: "localhost:8098" })).toContain("http:// 또는 https:// 로 시작해야 합니다.");
  });

  it("진단 중에는 진행 상태를 보여준다", () => {
    const html = render({ busy: true });

    expect(html).toContain("확인하는 중…");
    expect(html).toContain("disabled");
  });

  it("성공 진단은 모델과 켜짐·꺼짐 기능을 함께 보여준다", () => {
    const result: BrainDiagnosis = {
      kind: "ok",
      summary: { status: "", model: "qwen2.5:7b", provider: "ollama", enabled: ["기억", "감정"], disabled: ["선제 제안"] },
    };
    const html = render({ result });

    expect(html).toContain("brain-diagnosis ok");
    expect(html).toContain("연결됨 · qwen2.5:7b (ollama)");
    expect(html).toContain("켜짐 · 기억, 감정");
    expect(html).toContain("꺼짐 · 선제 제안");
  });

  it("실패 진단은 실패 표시와 조치 문구를 보여준다", () => {
    const html = render({ result: { kind: "timeout", timeoutMs: 5_000 } });

    expect(html).toContain("brain-diagnosis fail");
    expect(html).toContain("5초 안에 응답이 없습니다");
  });

  it("HTTP 오류와 네트워크 오류를 다른 문구로 구분한다", () => {
    expect(render({ result: { kind: "http-error", status: 404 } })).toContain("HTTP 404");
    expect(render({ result: { kind: "network-error", message: "Failed to fetch" } })).toContain("주소와 포트, 서버 상태를 확인해 주세요.");
  });

  it("데스크톱 런타임이 아니면 재연결을 제공하지 않는다", () => {
    expect(render({ canReconnect: false })).toContain("disabled");
  });

  it("주소 변경이 대화와 음성 인식에 함께 적용된다는 사실을 알린다", () => {
    expect(render()).toContain("대화 연결과 음성 인식이 함께 새 주소를 사용합니다");
  });
});
