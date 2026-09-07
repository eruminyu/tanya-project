export function shouldIgnoreCursorEvents(
  interaction: "click-through" | "interactive" | "dragging",
  tauriRuntime: boolean,
): boolean {
  return tauriRuntime && interaction === "click-through";
}
