import type { LlmRoute } from "./brain";

export interface ConversationMessage {
  id: string;
  role: "user" | "tanya";
  text: string;
  route?: LlmRoute;
}

export type WhisperSide = "left" | "right";

export function latestTanyaMessage(messages: readonly ConversationMessage[]): ConversationMessage | undefined {
  return [...messages].reverse().find((message) => message.role === "tanya");
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
