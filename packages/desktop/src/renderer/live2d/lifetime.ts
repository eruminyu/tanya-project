/** Owns one canvas generation. Aborted or late resources are released once. */
export class StageLifetime {
  private readonly controller = new AbortController();
  private cleanups: Array<() => void> = [];

  get signal(): AbortSignal { return this.controller.signal; }
  get disposed(): boolean { return this.signal.aborted; }

  add(cleanup: () => void): void {
    if (this.disposed) cleanup();
    else this.cleanups.push(cleanup);
  }

  check(): void { this.signal.throwIfAborted(); }

  dispose(): void {
    if (this.disposed) return;
    this.controller.abort();
    const pending = this.cleanups;
    this.cleanups = [];
    for (const cleanup of pending.reverse()) {
      try { cleanup(); } catch { /* Release every resource even after context loss. */ }
    }
  }
}

export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
