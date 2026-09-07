import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentDock } from "./AgentDock";
import { initialAgentDockState } from "./agent-dock";
import type { GoogleWriteState } from "./google-write";


const noop = () => undefined;

function renderGoogle(state: GoogleWriteState): string {
  return renderToStaticMarkup(
    <AgentDock
      state={initialAgentDockState}
      googleWrite={state}
      onApproveGoogle={noop}
      onCancelGoogle={noop}
      onClose={noop}
    />,
  );
}

describe("Agent Dock Google 웹 데모", () => {
  it("서버 실행 초안은 데모 계정 경계와 승인·취소 버튼을 함께 표시한다", () => {
    const html = renderGoogle({
      status: "preview",
      draft: {
        kind: "task",
        requestId: "request-1",
        title: "발표 자료 정리",
        due: null,
        executor: "brain",
        approvalToken: "approval-1",
      },
    });

    expect(html).toContain("웹 체험판의 공용 데모 계정");
    expect(html).toContain("내 Google 계정에는 접근하지 않아요");
    expect(html).toContain("취소");
    expect(html).toContain("승인하고 생성");
  });

  it("Tauri 로컬 실행 초안에는 웹 데모 안내를 표시하지 않는다", () => {
    const html = renderGoogle({
      status: "preview",
      draft: {
        kind: "task",
        requestId: "request-2",
        title: "개인 할 일",
        due: null,
      },
    });

    expect(html).not.toContain("웹 체험판의 공용 데모 계정");
  });
});
