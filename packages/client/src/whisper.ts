import type { LlmRoute } from "./brain";

export interface ConversationMessage {
  id: string;
  role: "user" | "kirian";
  text: string;
  route?: LlmRoute;
}

export type WhisperSide = "left" | "right";

export function latestKirianMessage(messages: readonly ConversationMessage[]): ConversationMessage | undefined {
  return [...messages].reverse().find((message) => message.role === "kirian");
}

export function shouldCollapseWhisper(text: string, limit = 240): boolean {
  return text.length > limit;
}

export function whisperSide(
  characterBounds: Pick<DOMRect, "left" | "right">,
  viewportWidth: number,
  panelWidth: number,
): WhisperSide {
  const rightSpace = viewportWidth - characterBounds.right;
  const leftSpace = characterBounds.left;
  return rightSpace >= panelWidth || rightSpace >= leftSpace ? "right" : "left";
}
