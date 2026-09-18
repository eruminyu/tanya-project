// Hand-off of an approved calendar draft to the visitor's own calendar: a prefilled Google Calendar link and
// an .ics file. Nothing is written anywhere by the gateway; the visitor saves it in their own account.
import type { GoogleEventFields } from '../../desktop/src/main/external/google-calendar.js';

export interface HandoffResult {
  googleCalendarUrl: string;
  icsText: string;
  icsFileName: string;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Google's template link wants UTC instants as YYYYMMDDTHHMMSSZ, or YYYYMMDD for all-day (end exclusive). */
function googleStamp(time: GoogleEventFields['start']): string {
  if ('date' in time) return time.date.replaceAll('-', '');
  const date = new Date(time.dateTime);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function icsEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** RFC 5545 lines are folded at 75 octets; keep it simple with 70 characters (all ASCII-safe after escaping is not guaranteed, so count code units conservatively). */
function fold(line: string): string {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 70) { parts.push(rest.slice(0, 70)); rest = ' ' + rest.slice(70); }
  parts.push(rest);
  return parts.join('\r\n');
}

export function buildHandoff(event: GoogleEventFields, uid: string, timeZone: string, now: Date = new Date()): HandoffResult {
  const allDay = 'date' in event.start;
  const url = new URL('https://calendar.google.com/calendar/render');
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', event.summary);
  url.searchParams.set('dates', `${googleStamp(event.start)}/${googleStamp(event.end)}`);
  if (event.description) url.searchParams.set('details', event.description);
  if (event.location) url.searchParams.set('location', event.location);
  if (!allDay) url.searchParams.set('ctz', timeZone);

  const stamp = googleStamp({ dateTime: now.toISOString() });
  const start = allDay ? `DTSTART;VALUE=DATE:${googleStamp(event.start)}` : `DTSTART:${googleStamp(event.start)}`;
  const end = allDay ? `DTEND;VALUE=DATE:${googleStamp(event.end)}` : `DTEND:${googleStamp(event.end)}`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tanya//Public Demo//KO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${uid}@tanya-demo`, `DTSTAMP:${stamp}`, start, end, `SUMMARY:${icsEscape(event.summary)}`,
    ...(event.description ? [`DESCRIPTION:${icsEscape(event.description)}`] : []),
    ...(event.location ? [`LOCATION:${icsEscape(event.location)}`] : []),
    'END:VEVENT', 'END:VCALENDAR'];
  const safeName = event.summary.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 40) || 'tanya-event';
  return { googleCalendarUrl: url.toString(), icsText: lines.map(fold).join('\r\n') + '\r\n', icsFileName: `${safeName}.ics` };
}
