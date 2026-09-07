export const TOGGLE_CHAT_PANEL_EVENT = "tanya://toggle-chat-panel";
export const VOICE_PTT_EVENT = "tanya://voice-ptt";

export interface ShortcutStatus { available: boolean; accelerator: string; error?: string }

export function shortcutWarning(status: ShortcutStatus): string {
  return status.available ? "" : `${status.accelerator} 단축키를 사용할 수 없습니다. 캐릭터 클릭이나 메뉴를 이용해 주세요.`;
}

export function shortcutWarnings(statuses: ShortcutStatus[]): string {
  return statuses.map(shortcutWarning).filter(Boolean).join("\n");
}

export function toggleChatPanel(isOpen: boolean): boolean {
  return !isOpen;
}
