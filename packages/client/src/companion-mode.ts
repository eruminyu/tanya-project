export type CompanionMode =
  | { kind: "presence" }
  | { kind: "whisper"; expanded: boolean }
  | { kind: "utility"; panel: "calendar" | "tasks"; size: "small" | "medium" }
  | { kind: "agent-dock" };

export type InteractionState = "click-through" | "interactive" | "dragging";

export interface CompanionState {
  mode: CompanionMode;
  interaction: InteractionState;
}

export type CompanionAction =
  | { type: "lock" }
  | { type: "activate" }
  | { type: "open-whisper" }
  | { type: "open-agent-dock" }
  | { type: "close-overlay" }
  | { type: "drag-start" }
  | { type: "drag-end" };

export const initialCompanionState: CompanionState = {
  mode: { kind: "presence" },
  interaction: "interactive",
};

export function reduceCompanionState(state: CompanionState, action: CompanionAction): CompanionState {
  switch (action.type) {
    case "lock":
      return { ...state, interaction: "click-through" };
    case "activate":
    case "drag-end":
      return { ...state, interaction: "interactive" };
    case "open-whisper":
      return { mode: { kind: "whisper", expanded: false }, interaction: "interactive" };
    case "open-agent-dock":
      return { mode: { kind: "agent-dock" }, interaction: "interactive" };
    case "close-overlay":
      return { ...state, mode: { kind: "presence" } };
    case "drag-start":
      return state.interaction === "interactive" ? { ...state, interaction: "dragging" } : state;
  }
}
