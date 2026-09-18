// Proactive suggestion cards for one visitor, the demo counterpart of the desktop's calendar-time suggestions:
// when an event this visitor approved is about to start, the companion offers help before being asked.
// Only events created in this session are considered (never other visitors' or the operator's calendar), no
// model call is involved, and a card is shown once per event and withdrawn when the event starts.
import { createHash, randomUUID } from 'node:crypto';
import type { CommandResult } from '../../desktop/src/shared/bridge.js';
import type { DemoReceipt } from './demo-calendar.js';
import type { GoogleEventFields } from '../../desktop/src/main/external/google-calendar.js';

export interface ProactiveCardView {
  id: string;
  kind: 'calendar';
  text: string;
  quote: string;
  title: string;
  /** Start of the event the card is about (ms since epoch); the card expires then. */
  at: number;
  createdAt: number;
  expiresAt: number;
}

export interface DemoProactiveState {
  available: boolean;
  /** Approved events this session is watching (start times only; nothing else leaves the gateway). */
  watching: number;
  cards: ProactiveCardView[];
}

export interface DemoProactiveOptions {
  changed(): void;
  /** How far ahead an approved event triggers a card; the desktop uses 15 minutes. */
  leadMs?: number;
  tickMs?: number;
  now?: () => number;
  timeZone?: string;
  calendarLabel?: string;
}

interface WatchedEvent { key: string; summary: string; at: number; }

export const CALENDAR_CARD_TEXT = '곧 시작하는 일정에 필요한 준비를 확인해 볼까요?';
const MAX_WATCHED = 10;
const MAX_CARDS = 3;
const failure = (code: Extract<CommandResult, { ok: false }>['code']): CommandResult => ({ ok: false, code });

export class DemoProactive {
  private readonly watched: WatchedEvent[] = [];
  private readonly seen = new Set<string>();
  private cards: ProactiveCardView[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly leadMs: number;
  private readonly now: () => number;

  constructor(private readonly options: DemoProactiveOptions) {
    this.leadMs = options.leadMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => this.tick(), options.tickMs ?? 15_000);
    this.timer.unref?.();
  }

  snapshot(): DemoProactiveState {
    return { available: true, watching: this.watched.length, cards: structuredClone(this.cards) };
  }

  /** Called with every receipt; only a succeeded timed event in the future is watched. */
  record(receipt: DemoReceipt, event: GoogleEventFields): void {
    if (this.disposed || receipt.status !== 'succeeded' || !('dateTime' in event.start)) return;
    const at = Date.parse(event.start.dateTime);
    if (!Number.isFinite(at) || at <= this.now()) return;
    const key = createHash('sha256').update(JSON.stringify([receipt.created?.eventId ?? receipt.draftId, event.summary, at])).digest('hex');
    if (this.watched.some(item => item.key === key)) return;
    this.watched.push({ key, summary: event.summary, at });
    if (this.watched.length > MAX_WATCHED) this.watched.shift();
    this.tick();
  }

  dismiss(id: unknown): CommandResult {
    if (typeof id !== 'string' || !this.cards.some(card => card.id === id)) return failure('invalid_request');
    this.cards = this.cards.filter(card => card.id !== id);
    this.options.changed();
    return { ok: true };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cards = [];
    this.watched.length = 0;
  }

  private tick(): void {
    if (this.disposed) return;
    const now = this.now();
    const before = this.cards.length;
    this.cards = this.cards.filter(card => card.expiresAt > now);
    let added = false;
    for (const event of this.watched) {
      if (this.seen.has(event.key) || event.at <= now || event.at > now + this.leadMs) continue;
      this.seen.add(event.key);
      if (this.cards.length >= MAX_CARDS) continue;
      this.cards.unshift({ id: randomUUID(), kind: 'calendar', text: CALENDAR_CARD_TEXT, quote: event.summary,
        title: (this.options.calendarLabel ?? '캘린더') + ' · ' + new Date(event.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: this.options.timeZone ?? 'Asia/Seoul' }),
        at: event.at, createdAt: now, expiresAt: event.at });
      added = true;
    }
    // Events that already started no longer need watching.
    for (let index = this.watched.length - 1; index >= 0; index -= 1) if ((this.watched[index]?.at ?? 0) <= now) this.watched.splice(index, 1);
    if (added || this.cards.length !== before) this.options.changed();
  }
}
