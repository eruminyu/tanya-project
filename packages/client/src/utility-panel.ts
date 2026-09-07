export type UtilityPanelKind = "calendar" | "tasks";
export type UtilityPanelSize = "small" | "medium";
export type UtilityPanelState = { panel: UtilityPanelKind; size: UtilityPanelSize } | null;
export type UtilityPanelAction =
  | { type: "open"; panel: UtilityPanelKind }
  | { type: "toggle-size" }
  | { type: "close" };

export const initialUtilityState: UtilityPanelState = null;

export function reduceUtilityState(state: UtilityPanelState, action: UtilityPanelAction): UtilityPanelState {
  switch (action.type) {
    case "open": return { panel: action.panel, size: state?.size ?? "small" };
    case "toggle-size": return state ? { ...state, size: state.size === "small" ? "medium" : "small" } : state;
    case "close": return null;
  }
}

export function utilitySide(bounds: Pick<DOMRect, "left" | "right">, viewportWidth: number, panelWidth: number): "left" | "right" {
  const rightSpace = viewportWidth - bounds.right;
  const leftSpace = bounds.left;
  return rightSpace >= panelWidth || rightSpace >= leftSpace ? "right" : "left";
}

interface ExpansionInput {
  windowX: number;
  compactWidth: number;
  expandedWidth: number;
  monitorLeft: number;
  monitorRight: number;
}

export function expansionLayout(input: ExpansionInput): { side: "left" | "right"; expandedX: number } {
  if (input.windowX + input.expandedWidth <= input.monitorRight) {
    return { side: "right", expandedX: input.windowX };
  }
  return {
    side: "left",
    expandedX: Math.max(input.monitorLeft, input.windowX - (input.expandedWidth - input.compactWidth)),
  };
}
