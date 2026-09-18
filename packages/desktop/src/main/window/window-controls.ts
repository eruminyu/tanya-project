import type {EventEmitter} from 'node:events';
import {emptyWindowControls, RECOVERY_SHORTCUT, type WindowCommandResult, type WindowControlState} from '../../shared/window-controls.js';
import {fitWindowBounds, type Bounds, type DisplayArea, type FittedBounds, type SavedBounds} from './window-bounds.js';
import {restoreWindowBounds, sameBounds} from './restore-window-bounds.js';

interface ControlledWindow extends Pick<EventEmitter, 'on' | 'removeListener'> {
  isDestroyed(): boolean; isMinimized(): boolean; isMaximized(): boolean; isFullScreen(): boolean;
  getBounds(): Bounds; getNormalBounds(): Bounds; setBounds(bounds: Bounds): void; setMinimumSize(width: number, height: number): void;
  setIgnoreMouseEvents(ignore: boolean): void; restore(): void; unmaximize(): void; show(): void; focus(): void; close(): void;
}
interface ScreenPort extends Pick<EventEmitter, 'on' | 'removeListener'> {
  getAllDisplays(): DisplayArea[]; getPrimaryDisplay(): DisplayArea;
}
interface Ports {
  store: {read(): SavedBounds | null; write(value: SavedBounds): void}; screen: ScreenPort;
  interactionAllowed(): boolean;
  shortcuts: {register(key: string, callback: () => void): boolean; isRegistered(key: string): boolean; isSuspended(): boolean; unregister(key: string): void};
  changed(): void;
}
export class WindowControls {
  private window: ControlledWindow | null = null;
  private state = emptyWindowControls();
  private ownedShortcut = false;
  private persistenceBlocked = false;
  private adjusting = false;
  private userSizing = false;
  private restoredBounds: FittedBounds | null = null;
  private uncertainBounds: Bounds | null = null;
  private disposed = false;
  private lastWritten = '';
  private pendingBounds: SavedBounds | null = null;
  private minimumSize = '';
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private correctionTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly ports: Ports) {}
  snapshot(): WindowControlState { return {...this.state}; }
  private fit(saved: SavedBounds | null): FittedBounds {
    return fitWindowBounds(saved, this.ports.screen.getAllDisplays(), this.ports.screen.getPrimaryDisplay().id);
  }
  initialBounds(): FittedBounds {
    let saved: SavedBounds | null = null;
    try { saved = this.ports.store.read(); }
    catch { this.persistenceBlocked = true; this.state.boundsPersistenceError = true; }
    const fitted = this.fit(saved);
    this.restoredBounds = saved ? fitted : null;
    return fitted;
  }
  attach(window: ControlledWindow): void {
    if (this.disposed || this.window) throw new Error('window_already_attached');
    this.window = window;
    if (this.restoredBounds) {
      try {this.adjusting = true; this.applyMinimum(this.restoredBounds); this.applyBounds(this.restoredBounds.bounds);}
      catch {this.uncertainBounds = window.getBounds(); this.pendingBounds = null;}
      finally {this.adjusting = false; this.restoredBounds = null;}
    }
    window.setIgnoreMouseEvents(false);
    try { this.ownedShortcut = this.ports.shortcuts.register(RECOVERY_SHORTCUT, () => { this.recover(); }); }
    catch { this.ownedShortcut = false; }
    this.checkRecovery();
    for (const name of ['move', 'resize']) window.on(name, this.scheduleBounds);
    for (const name of ['will-move', 'will-resize']) window.on(name, this.beginUserSizing);
    for (const name of ['moved', 'resized']) window.on(name, this.endUserSizing);
    for (const name of ['restore', 'unmaximize', 'leave-full-screen']) window.on(name, this.displayChanged);
    window.on('focus', this.disableClickThrough);
    window.on('close', this.flushBounds);
    window.on('closed', this.dispose);
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) this.ports.screen.on(name, this.displayChanged);
    this.healthTimer = setInterval(() => this.checkRecovery(), 1000);
    this.healthTimer.unref();
  }
  checkRecovery(): void {
    if (this.disposed) return;
    let available = false;
    try { available = this.ownedShortcut && this.ports.shortcuts.isRegistered(RECOVERY_SHORTCUT) && !this.ports.shortcuts.isSuspended(); }
    catch { /* Failure must not leave an input-transparent window. */ }
    const changed = this.state.recoveryAvailable !== available;
    this.state.recoveryAvailable = available;
    if (!available) this.disableClickThrough();
    if (changed) this.ports.changed();
  }
  setClickThrough(value: unknown): WindowCommandResult {
    if (typeof value !== 'boolean') return {ok: false, code: 'invalid_request'};
    const window = this.window;
    if (this.disposed || !window || window.isDestroyed()) return {ok: false, code: 'window_unavailable'};
    if (value) {
      this.checkRecovery();
      if (!this.state.recoveryAvailable) return {ok: false, code: 'shortcut_unavailable'};
      // Read current main-owned lifecycle state, including queued requests after lock/suspend.
      if (!this.ports.interactionAllowed()) return {ok: false, code: 'interaction_blocked'};
    }
    try { window.setIgnoreMouseEvents(value); }
    catch {
      // A native failure can occur after applying the flag. Clear it or close only our window.
      this.state.clickThrough = false;
      try { window.setIgnoreMouseEvents(false); } catch { window.close(); }
      this.ports.changed();
      return {ok: false, code: 'window_unavailable'};
    }
    this.state.clickThrough = value;
    this.ports.changed();
    return {ok: true};
  }
  disableClickThrough = (): void => {
    if (this.state.clickThrough) this.setClickThrough(false);
  };
  recover(): WindowCommandResult {
    const result = this.setClickThrough(false), window = this.window;
    if (!result.ok || !window || window.isDestroyed()) return result;
    try {
      if (window.isMinimized()) window.restore();
      if (window.isMaximized()) window.unmaximize();
      this.correctBounds();
      window.show(); window.focus();
      return {ok: true};
    } catch { return {ok: false, code: 'window_unavailable'}; }
  }
  private displayChanged = (): void => {
    this.disableClickThrough();
    try { this.correctBounds(); } catch { /* A transient display list can be empty during topology changes. */ }
  };
  private correctBounds = (): void => {
    const window = this.window;
    if (this.disposed || !window || window.isDestroyed() || this.adjusting || this.userSizing) return;
    try {
      const fitted = this.fit({version: 1, bounds: window.getNormalBounds(), displayId: null});
      this.adjusting = true;
      this.applyMinimum(fitted);
      if (!window.isMinimized() && !window.isMaximized() && !window.isFullScreen()
        && !sameBounds(window.getBounds(), fitted.bounds)) this.applyBounds(fitted.bounds);
    } finally { this.adjusting = false; }
    this.scheduleBounds();
  };
  private beginUserSizing = (): void => {this.userSizing = true;};
  private endUserSizing = (): void => {this.userSizing = false; this.scheduleBounds();};
  private applyBounds(bounds: Bounds): void {
    const window = this.window!;
    const displays = () => JSON.stringify(this.ports.screen.getAllDisplays());
    const before = displays();
    const stable = () => !this.disposed && !window.isDestroyed() && !this.userSizing
      && !window.isMinimized() && !window.isMaximized() && !window.isFullScreen() && displays() === before;
    let settled = false;
    try {settled = restoreWindowBounds(window, bounds, stable);}
    catch { /* Preserve the previous saved geometry if the native setter fails. */ }
    finally {
      this.uncertainBounds = settled ? null : window.isDestroyed() ? null : window.getBounds();
      if (!settled) this.pendingBounds = null;
    }
    if (!this.disposed && !window.isDestroyed() && displays() !== before) {
      clearTimeout(this.correctionTimer);
      this.correctionTimer = setTimeout(this.displayChanged, 0);
      this.correctionTimer.unref();
    }
  }
  private applyMinimum(fitted: FittedBounds): void {
    const key = `${fitted.minWidth},${fitted.minHeight}`;
    if (key === this.minimumSize) return;
    const wasAdjusting = this.adjusting;
    try {
      this.adjusting = true;
      this.window!.setMinimumSize(fitted.minWidth, fitted.minHeight);
      this.minimumSize = key;
    } finally { this.adjusting = wasAdjusting; }
  }
  private scheduleBounds = (): void => {
    if (this.disposed || this.adjusting) return;
    try { this.captureNormalBounds(); } catch { /* Retry when the display topology settles. */ }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(this.flushBounds, 250); this.saveTimer.unref();
  };
  private captureNormalBounds(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || window.isMinimized() || window.isMaximized() || window.isFullScreen()) return;
    const actual = window.getNormalBounds();
    // Do not turn an unrepresentable native result into a growing saved size.
    // A later user/OS change releases this fence and is saved normally.
    if (this.uncertainBounds && sameBounds(actual, this.uncertainBounds)) return;
    this.uncertainBounds = null;
    const fitted = this.fit({version: 1, bounds: actual, displayId: null});
    this.applyMinimum(fitted);
    this.pendingBounds = {version: 1, bounds: fitted.bounds, displayId: fitted.displayId};
  }
  flushBounds = (): void => {
    clearTimeout(this.saveTimer); this.saveTimer = undefined;
    const window = this.window;
    if (this.disposed || this.persistenceBlocked || !window || window.isDestroyed()) return;
    try {
      this.captureNormalBounds();
      if (!this.pendingBounds) return;
      const fitted = this.fit(this.pendingBounds);
      const saved: SavedBounds = {version: 1, bounds: fitted.bounds, displayId: fitted.displayId};
      const json = JSON.stringify(saved);
      if (json === this.lastWritten && !this.state.boundsPersistenceError) return;
      this.ports.store.write(saved); this.lastWritten = json;
      if (this.state.boundsPersistenceError) { this.state.boundsPersistenceError = false; this.ports.changed(); }
    } catch { if (!this.state.boundsPersistenceError) { this.state.boundsPersistenceError = true; this.ports.changed(); } }
  };
  dispose = (): void => {
    if (this.disposed) return;
    this.flushBounds();
    this.disableClickThrough();
    this.disposed = true;
    clearTimeout(this.saveTimer); clearInterval(this.healthTimer); clearTimeout(this.correctionTimer);
    if (this.ownedShortcut) this.ports.shortcuts.unregister(RECOVERY_SHORTCUT);
    this.ownedShortcut = false; this.state.recoveryAvailable = false;
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) this.ports.screen.removeListener(name, this.displayChanged);
    if (this.window) {
      for (const name of ['move', 'resize']) this.window.removeListener(name, this.scheduleBounds);
      for (const name of ['will-move', 'will-resize']) this.window.removeListener(name, this.beginUserSizing);
      for (const name of ['moved', 'resized']) this.window.removeListener(name, this.endUserSizing);
      for (const name of ['restore', 'unmaximize', 'leave-full-screen']) this.window.removeListener(name, this.displayChanged);
      this.window.removeListener('focus', this.disableClickThrough);
      this.window.removeListener('close', this.flushBounds); this.window.removeListener('closed', this.dispose);
    }
    this.window = null;
  };
}
