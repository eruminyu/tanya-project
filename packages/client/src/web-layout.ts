/** 모바일 웹도 Live2D를 표시하므로 채팅 전용 폴백은 사용하지 않는다. */
export function shouldUseCompactWebLayout(_tauriRuntime: boolean, _narrowViewport: boolean): boolean {
  return false;
}

export function shouldRenderSettingsWindow(requested: boolean, tauriRuntime: boolean): boolean {
  return requested && tauriRuntime;
}

export function shouldUseTauriGoogleUi(tauriRuntime: boolean): boolean {
  return tauriRuntime;
}

export function shouldShowConversation(tauriRuntime: boolean, chatPanelOpen: boolean): boolean {
  return !tauriRuntime || chatPanelOpen;
}

export function shouldShowConversationClose(tauriRuntime: boolean): boolean {
  return tauriRuntime;
}

export function useCompactWebLayout(tauriRuntime: boolean): boolean {
  return shouldUseCompactWebLayout(tauriRuntime, false);
}

/**
 * 좁은 화면 판정.
 *
 * 520px는 T-035가 모바일 레이아웃 경계로 쓰는 값과 같다. CSS와 JS가 서로 다른
 * 기준을 쓰면 "CSS는 모바일인데 JS는 아니라고 보는" 어긋남이 생기므로 상수를 공유한다.
 */
export const NARROW_VIEWPORT_QUERY = "(max-width: 520px)";

export function isNarrowViewport(
  matchMedia: ((query: string) => { matches: boolean }) | undefined =
    typeof window === "undefined" ? undefined : window.matchMedia?.bind(window),
): boolean {
  if (!matchMedia) return false;
  try {
    return matchMedia(NARROW_VIEWPORT_QUERY).matches;
  } catch {
    return false;
  }
}
