// Real execution for the public demo: approved drafts are written to a dedicated, publicly readable demo
// Google calendar with the desktop's GoogleCalendarAccount (same proof: read-back of the created event with the
// execution marker). Visitor text becomes public for a while, so titles are prefixed and events are swept.
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { GoogleCalendarAccount, type CredentialStore, type GoogleEventFields } from '../../desktop/src/main/external/google-calendar.js';
import type { CalendarView } from '../../desktop/src/shared/external.js';
import type { CalendarExecutor, ExecutionOutcome } from './demo-calendar.js';

export interface GoogleDemoOptions {
  /** Credential JSON produced by the authorize command (mode 0600); refreshed tokens are written back. */
  credentialFile: string;
  calendarId: string;
  /** Minutes a created event stays before the sweeper deletes it. */
  cleanupMinutes: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface DemoCalendarEvent { id: string; summary: string; start: GoogleEventFields['start']; end: GoogleEventFields['end']; }

export const DEMO_PREFIX = '[데모] ';
const LIST_CACHE_MS = 15_000;
const MAX_SUMMARY = 80;

/** File-backed store for one credential; the account rotates its generation on restore and refresh. */
function fileVault(path: string, key: string): CredentialStore {
  return {
    async get(name) { return name === key ? readFile(path, 'utf8') : null; },
    async set(name, value) {
      if (name !== key) throw new Error('google_demo_unexpected_credential');
      await writeFile(path + '.tmp', value, { mode: 0o600 });
      await rename(path + '.tmp', path);
    },
    async delete() { throw new Error('google_demo_credential_is_managed_by_the_operator'); },
  };
}

/** Google's public event page for a calendar that is shared with everyone. */
export function eventLink(eventId: string, calendarId: string): string {
  return 'https://calendar.google.com/calendar/event?eid=' + Buffer.from(`${eventId} ${calendarId}`, 'utf8').toString('base64').replace(/=+$/, '');
}

export class GoogleDemoExecutor implements CalendarExecutor {
  readonly kind = 'google_demo' as const;
  readonly boundary = 'cloud' as const;
  private readonly created = new Map<string, { at: number; plan: Parameters<GoogleCalendarAccount['execute']>[0] }>();
  private listing: { at: number; value: DemoCalendarEvent[] } | null = null;
  private constructor(private readonly account: GoogleCalendarAccount, readonly calendar: CalendarView, private readonly options: GoogleDemoOptions) {}
  get accountId(): string { return this.account.accountId; }

  static async create(options: GoogleDemoOptions): Promise<GoogleDemoExecutor> {
    const raw = JSON.parse(await readFile(options.credentialFile, 'utf8')) as { subject?: unknown };
    if (typeof raw.subject !== 'string' || !raw.subject) throw new Error('google_demo_credential_invalid');
    const accountId = 'google:' + createHash('sha256').update(raw.subject).digest('hex');
    const dependencies = { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) };
    const account = await GoogleCalendarAccount.restore(accountId, fileVault(options.credentialFile, 'google-calendar:' + accountId), dependencies);
    const calendars = await account.listCalendars();
    const calendar = calendars.find(item => item.id === options.calendarId);
    if (!calendar) throw new Error('google_demo_calendar_not_found');
    if (!calendar.canWrite) throw new Error('google_demo_calendar_read_only');
    return new GoogleDemoExecutor(account, { id: calendar.id, label: calendar.label, timeZone: calendar.timeZone, accessRole: calendar.accessRole, canWrite: true }, options);
  }

  /** Applied before the visitor sees the draft, so the approved text is exactly what gets written. */
  decorate(event: GoogleEventFields): GoogleEventFields {
    const summary = event.summary.startsWith(DEMO_PREFIX) ? event.summary : DEMO_PREFIX + event.summary;
    return { ...event, summary: [...summary].slice(0, MAX_SUMMARY).join(''), description: [...event.description].slice(0, 500).join(''), location: [...event.location].slice(0, 200).join('') };
  }

  async execute(event: GoogleEventFields, draftId: string): Promise<ExecutionOutcome> {
    const plan = await this.account.prepare('create', this.calendar.id, event);
    const executionId = 'demo-' + draftId;
    const result = await this.account.execute(plan, executionId);
    if (result.status !== 'succeeded' || !result.operationId) throw new Error(result.errorCode ?? (result.status === 'unknown' ? 'google_write_unconfirmed' : 'google_write_failed'));
    // The proof already came from the write response; a second read confirms the event is really there.
    const readBack = (await this.account.reconcile(plan, executionId)).status === 'succeeded';
    this.created.set(result.operationId, { at: (this.options.now ?? Date.now)(), plan });
    this.listing = null;
    const minutes = this.options.cleanupMinutes;
    return {
      providerOperationId: result.operationId,
      result: { kind: 'calendar_created', status: 'created', eventId: result.operationId, summary: event.summary, start: event.start, end: event.end,
        calendar: this.calendar.label, readBack,
        status_message: `승인하신 "${event.summary}" 일정을 공개 데모 캘린더에 실제로 만들었어요${readBack ? ' (재조회로 확인됨)' : ' (재조회 확인은 아직)'}. 화면의 영수증과 일정표에서 볼 수 있고, 약 ${minutes}분 뒤 자동으로 삭제돼요.` },
      handoff: null,
      created: { eventId: result.operationId, htmlLink: eventLink(result.operationId, this.calendar.id), calendarLabel: this.calendar.label, readBack },
    };
  }

  /** Upcoming events of the demo calendar for the public view; cached briefly since every visitor asks. */
  async listUpcoming(): Promise<DemoCalendarEvent[]> {
    const now = (this.options.now ?? Date.now)();
    if (this.listing && now - this.listing.at < LIST_CACHE_MS) return this.listing.value;
    const events = await this.account.listEvents(this.calendar.id, { timeMin: new Date(now - 3_600_000).toISOString(), timeMax: new Date(now + 14 * 86_400_000).toISOString() });
    const value = events.map(item => ({ id: item.id, summary: item.summary, start: item.start, end: item.end }));
    this.listing = { at: now, value };
    return value;
  }

  /** Deletes demo events older than the retention, and at start every demo-prefixed event left behind. */
  async sweep(initial = false): Promise<number> {
    const now = (this.options.now ?? Date.now)();
    let removed = 0;
    if (initial) {
      const events = await this.account.listEvents(this.calendar.id, { timeMin: new Date(now - 30 * 86_400_000).toISOString(), timeMax: new Date(now + 330 * 86_400_000).toISOString() });
      for (const item of events) {
        if (!item.summary.startsWith(DEMO_PREFIX)) continue;
        if (await this.remove(item.id)) removed += 1;
      }
    }
    for (const [eventId, entry] of this.created) {
      if (now - entry.at < this.options.cleanupMinutes * 60_000) continue;
      if (await this.remove(eventId)) removed += 1;
      this.created.delete(eventId);
    }
    if (removed) this.listing = null;
    return removed;
  }

  async deleteCreated(eventIds: string[]): Promise<number> {
    let removed = 0;
    for (const eventId of eventIds) {
      if (!this.created.has(eventId)) continue;
      if (await this.remove(eventId)) removed += 1;
      this.created.delete(eventId);
    }
    if (removed) this.listing = null;
    return removed;
  }

  private async remove(eventId: string): Promise<boolean> {
    try {
      const plan = await this.account.prepare('delete', this.calendar.id, { eventId });
      const result = await this.account.execute(plan, 'demo-sweep-' + eventId);
      return result.status === 'succeeded';
    } catch { return false; }
  }
}
