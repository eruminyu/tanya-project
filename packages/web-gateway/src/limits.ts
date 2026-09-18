// Unauthenticated public traffic is bounded by totals, not by identity. The shape follows the earlier public
// demo's limiter (packages/brain/core/rate_limit.py in the Tanya snapshot): a real-client key taken from the
// proxy headers, a per-key sliding window, per-key concurrency and forgetting quiet keys.
import type { IncomingHttpHeaders } from 'node:http';

const IP_HEADERS = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'] as const;
const HOUR_MS = 3_600_000;
const FORGET_AFTER_MS = 600_000;

/** Which address a request really came from; behind a proxy every socket address is the proxy. */
export function clientKey(headers: IncomingHttpHeaders, socketAddress: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    for (const name of IP_HEADERS) {
      const value = headers[name];
      const first = (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return socketAddress?.trim() || 'unknown';
}

interface ClientRecord { starts: number[]; active: number; lastSeen: number; }

export type LimitDecision = { allowed: true } | { allowed: false; reason: 'client_rate' | 'client_concurrency' | 'total_concurrency'; retryAfterSeconds: number };

export class SessionLimiter {
  private readonly clients = new Map<string, ClientRecord>();
  private active = 0;
  constructor(
    private readonly sessionsPerHour: number,
    private readonly concurrentPerClient: number,
    private readonly concurrentTotal: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Decide and, when allowed, count one new session for the key. Pair every allowance with release(). */
  acquire(key: string): LimitDecision {
    const moment = this.now();
    this.forgetIdle(moment);
    const client = this.clients.get(key) ?? { starts: [], active: 0, lastSeen: moment };
    client.lastSeen = moment;
    client.starts = client.starts.filter(started => moment - started < HOUR_MS);
    if (this.active >= this.concurrentTotal) return { allowed: false, reason: 'total_concurrency', retryAfterSeconds: 30 };
    if (client.active >= this.concurrentPerClient) return { allowed: false, reason: 'client_concurrency', retryAfterSeconds: 30 };
    if (client.starts.length >= this.sessionsPerHour) {
      const oldest = client.starts[0] ?? moment;
      return { allowed: false, reason: 'client_rate', retryAfterSeconds: Math.max(1, Math.ceil((oldest + HOUR_MS - moment) / 1000)) };
    }
    client.starts.push(moment);
    client.active += 1;
    this.active += 1;
    this.clients.set(key, client);
    return { allowed: true };
  }

  release(key: string): void {
    const client = this.clients.get(key);
    if (!client) return;
    client.active = Math.max(0, client.active - 1);
    this.active = Math.max(0, this.active - 1);
    client.lastSeen = this.now();
  }

  activeSessions(): number { return this.active; }
  trackedClients(): number { return this.clients.size; }

  private forgetIdle(moment: number): void {
    for (const [key, client] of this.clients) {
      if (client.active === 0 && moment - client.lastSeen > FORGET_AFTER_MS && !client.starts.some(started => moment - started < HOUR_MS))
        this.clients.delete(key);
    }
  }
}

/** Generation slots shared by every visitor: the VM has one GPU, so extra turns are refused, not queued. */
export class TurnSlots {
  private held = 0;
  constructor(private readonly capacity: number) {}
  acquire(): boolean {
    if (this.held >= this.capacity) return false;
    this.held += 1;
    return true;
  }
  release(): void { this.held = Math.max(0, this.held - 1); }
  inUse(): number { return this.held; }
}
