export const RECOVERY_SHORTCUT = 'CommandOrControl+Alt+T';
export const RECOVERY_SHORTCUT_LABEL = 'Ctrl+Alt+T (macOS: ⌘+Alt+T)';
export interface WindowControlState {
  clickThrough: boolean;
  recoveryShortcut: string;
  recoveryAvailable: boolean;
  boundsPersistenceError: boolean;
}
export type WindowState = WindowControlState & {alwaysOnTop: boolean};
export type WindowCommandResult = {ok: true} | {ok: false; code: 'invalid_request' | 'window_unavailable' | 'shortcut_unavailable' | 'interaction_blocked'};
export function emptyWindowControls(): WindowControlState {
  return {clickThrough: false, recoveryShortcut: RECOVERY_SHORTCUT_LABEL, recoveryAvailable: false, boundsPersistenceError: false};
}
