import { useCallback, useEffect, useReducer, useRef, useState, type PointerEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { shortcutWarnings, TOGGLE_CHAT_PANEL_EVENT, toggleChatPanel, type ShortcutStatus } from "../chat-panel";
import { initialCompanionState, reduceCompanionState, type CompanionState } from "../companion-mode";
import { isDragIntent, type PointerPoint } from "../drag-intent";
import { expansionLayout } from "../utility-panel";

const COMPACT_WIDTH = 440;
const EXPANDED_WIDTH = 780;
const WINDOW_HEIGHT = 640;

export function useCompanionWindow(): {
  tauriRuntime: boolean;
  companionState: CompanionState;
  chatPanelOpen: boolean;
  isChatPanelOpen: () => boolean;
  changeChatPanelOpen: (next: boolean) => Promise<void>;
  lockCompanion: () => Promise<void>;
  activateCompanion: () => void;
  notifyOverlayOpened: (kind: "whisper" | "agent-dock") => void;
  notifyOverlayClosed: () => void;
  expandWindow: () => Promise<void>;
  restoreWindow: () => Promise<void>;
  utilitySide: "left" | "right";
  beginCharacterDrag: (event: PointerEvent<HTMLElement>) => void;
  continueCharacterDrag: (event: PointerEvent<HTMLElement>) => void;
  finishCharacterDrag: () => void;
  isDragging: () => boolean;
  openSettingsWindow: () => Promise<void>;
  shortcutError: string;
  reportShortcutError: (message: string) => void;
} {
  const [shortcutError, setShortcutError] = useState("");
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  const [utilitySide, setUtilitySide] = useState<"left" | "right">("right");
  const [companionState, dispatchCompanion] = useReducer(reduceCompanionState, initialCompanionState);
  const chatPanelOpenRef = useRef(false);
  const dragStartRef = useRef<PointerPoint | null>(null);
  const draggingRef = useRef(false);
  const compactPositionRef = useRef<PhysicalPosition | null>(null);
  const tauriRuntime = isTauri();

  const changeChatPanelOpen = useCallback(async (nextOpen: boolean) => {
    try {
      if (isTauri()) {
        await getCurrentWindow().setIgnoreCursorEvents(false);
      }
      chatPanelOpenRef.current = nextOpen;
      setChatPanelOpen(nextOpen);
      dispatchCompanion({ type: nextOpen ? "open-whisper" : "close-overlay" });
      setShortcutError("");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("상호작용 모드 전환 실패", error);
      setShortcutError(`상호작용 모드 전환 실패: ${message}`);
    }
  }, []);

  const lockCompanion = useCallback(async () => {
    try {
      if (isTauri()) await getCurrentWindow().setIgnoreCursorEvents(true);
      dispatchCompanion({ type: "lock" });
      setChatPanelOpen(false);
      chatPanelOpenRef.current = false;
      setShortcutError("");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setShortcutError(`잠금 모드 전환 실패: ${message}`);
    }
  }, []);

  const isChatPanelOpen = useCallback(() => chatPanelOpenRef.current, []);
  const reportShortcutError = useCallback((message: string) => setShortcutError(message), []);
  const activateCompanion = useCallback(() => dispatchCompanion({ type: "activate" }), []);
  const notifyOverlayOpened = useCallback((kind: "whisper" | "agent-dock") => {
    dispatchCompanion({ type: kind === "whisper" ? "open-whisper" : "open-agent-dock" });
  }, []);
  const notifyOverlayClosed = useCallback(() => dispatchCompanion({ type: "close-overlay" }), []);

  useEffect(() => {
    if (!tauriRuntime) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    setShortcutError("");
    void invoke<ShortcutStatus[]>("shortcut_status")
      .then((statuses) => { if (!disposed) setShortcutError(shortcutWarnings(statuses)); })
      .catch((error: unknown) => {
        if (!disposed) setShortcutError(`단축키 상태 확인 실패: ${error instanceof Error ? error.message : String(error)}`);
      });
    void listen(TOGGLE_CHAT_PANEL_EVENT, () => {
      dispatchCompanion({ type: "activate" });
      void changeChatPanelOpen(toggleChatPanel(chatPanelOpenRef.current));
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Ctrl+Space 이벤트 리스너 등록 실패", error);
      if (!disposed) setShortcutError(`단축키 연결 실패: ${message}`);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [changeChatPanelOpen, tauriRuntime]);

  const expandWindow = useCallback(async () => {
    if (!tauriRuntime) return;
    const window = getCurrentWindow();
    const [position, monitor] = await Promise.all([window.outerPosition(), currentMonitor()]);
    compactPositionRef.current = position;
    if (monitor) {
      const layout = expansionLayout({
        windowX: position.x,
        compactWidth: COMPACT_WIDTH * monitor.scaleFactor,
        expandedWidth: EXPANDED_WIDTH * monitor.scaleFactor,
        monitorLeft: monitor.position.x,
        monitorRight: monitor.position.x + monitor.size.width,
      });
      setUtilitySide(layout.side);
      await window.setPosition(new PhysicalPosition(layout.expandedX, position.y));
    }
    await window.setSize(new LogicalSize(EXPANDED_WIDTH, WINDOW_HEIGHT));
  }, [tauriRuntime]);

  const restoreWindow = useCallback(async () => {
    if (!tauriRuntime) return;
    const window = getCurrentWindow();
    await window.setSize(new LogicalSize(COMPACT_WIDTH, WINDOW_HEIGHT));
    if (compactPositionRef.current) await window.setPosition(compactPositionRef.current);
  }, [tauriRuntime]);

  const beginCharacterDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || chatPanelOpenRef.current) return;
    dragStartRef.current = { x: event.screenX, y: event.screenY };
    draggingRef.current = false;
  }, []);

  const continueCharacterDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    const start = dragStartRef.current;
    if (!start || draggingRef.current || !isDragIntent(start, { x: event.screenX, y: event.screenY })) return;
    draggingRef.current = true;
    dispatchCompanion({ type: "drag-start" });
    if (tauriRuntime) void getCurrentWindow().startDragging().finally(() => dispatchCompanion({ type: "drag-end" }));
  }, [tauriRuntime]);

  const finishCharacterDrag = useCallback(() => {
    dragStartRef.current = null;
  }, []);

  const isDragging = useCallback(() => {
    const dragging = draggingRef.current;
    if (dragging) draggingRef.current = false;
    return dragging;
  }, []);

  const openSettingsWindow = useCallback(async () => {
    setShortcutError("");
    try {
      if (!tauriRuntime) {
        window.open(`${window.location.pathname}?window=settings`, "tanya-settings", "width=760,height=760");
        return;
      }
      const existing = await WebviewWindow.getByLabel("settings");
      if (existing) {
        await existing.setFocus();
        return;
      }
      const settingsWindow = new WebviewWindow("settings", {
        url: "?window=settings",
        title: "타냐 설정",
        width: 760,
        height: 760,
        minWidth: 620,
        minHeight: 620,
        center: true,
        decorations: false,
        transparent: false,
        alwaysOnTop: false,
      });
      void settingsWindow.once("tauri://error", (event) => {
        setShortcutError(`설정 창 생성 실패: ${String(event.payload)}`);
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setShortcutError(`설정 창 열기 실패: ${message}`);
    }
  }, [tauriRuntime]);

  return {
    tauriRuntime,
    companionState,
    chatPanelOpen,
    isChatPanelOpen,
    changeChatPanelOpen,
    lockCompanion,
    activateCompanion,
    notifyOverlayOpened,
    notifyOverlayClosed,
    expandWindow,
    restoreWindow,
    utilitySide,
    beginCharacterDrag,
    continueCharacterDrag,
    finishCharacterDrag,
    isDragging,
    openSettingsWindow,
    shortcutError,
    reportShortcutError,
  };
}
