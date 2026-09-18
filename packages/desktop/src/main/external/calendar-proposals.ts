import type { CalendarView } from '../../shared/external.js';
import { canonicalJson } from './external-executor.js';

export function calendarOperation(name: string): 'create'|'update'|'delete' {
  if(name==='calendar.create')return 'create';
  if(name==='calendar.update')return 'update';
  if(name==='calendar.delete')return 'delete';
  throw Error('external_invalid_selection');
}

/** Fixed example instant so the description stays identical for the life of a candidate (never the current date). */
const exampleInstant='2026-01-15T12:00:00Z';
export function exampleOffset(timeZone: string): string {
  try {
    const name=new Intl.DateTimeFormat('en-US',{timeZone,timeZoneName:'longOffset'}).formatToParts(new Date(exampleInstant)).find(p=>p.type==='timeZoneName')?.value??'GMT';
    return /^GMT[+-]\d{2}:\d{2}$/.test(name)?name.slice(3):'+00:00';
  } catch { return '+00:00'; }
}

/** The host binds account/calendar/operation; the model supplies event fields only. */
export function calendarProposal(name: string, calendar: CalendarView) {
  const operation=calendarOperation(name);
  const time={oneOf:[
    {type:'object',properties:{date:{type:'string',description:'YYYY-MM-DD'}},required:['date'],additionalProperties:false},
    {type:'object',properties:{dateTime:{type:'string',description:'ISO 8601 with explicit UTC offset'},timeZone:{type:'string'}},required:['dateTime'],additionalProperties:false},
  ]};
  const fields={summary:{type:'string'},start:time,end:time,description:{type:'string'},location:{type:'string'}};
  const eventId={type:'string',description:'Exact existing event ID supplied by the user; never invent an ID.'};
  const schema={type:'object',additionalProperties:false,
    properties:operation==='delete'?{eventId}:operation==='update'?{eventId,...fields}:fields,
    required:operation==='delete'?['eventId']:operation==='update'?['eventId','summary','start','end']:['summary','start','end']};
  const label={create:'일정 만들기',update:'일정 수정',delete:'일정 삭제'}[operation];
  // Small local models read "approval is required" as "ask in chat first" and skip the call, so the
  // description states that the call itself is the draft the app shows for approval and shows the
  // exact start/end shape; strict validation of the arguments stays in google-calendar.ts.
  const offset=exampleOffset(calendar.timeZone);
  const draft=`${label}. Selected calendar: ${calendar.label}; time zone: ${calendar.timeZone}. Calling this tool is the only way to prepare a draft: the app shows the exact draft to the user, who approves or rejects it there, and the call itself writes nothing. When the user asks for this, call the tool immediately with the fields. Never write the draft as chat text, never ask for confirmation, and never ask for optional details.`;
  const timing=` Resolve relative dates (내일, 이번 금요일, 다음 주 ...) from the current date in the system prompt yourself. start and end must be objects, never plain strings: {"dateTime":"2026-01-15T09:00:00${offset}","timeZone":"${calendar.timeZone}"} for a timed event or {"date":"2026-01-15"} for an all-day event. dateTime always includes the calendar's UTC offset. end must be later than start; if no end time is given, end one hour after the start. One non-recurring event without attendees or conferencing. description and location may be empty strings. Ask only when the start date or time is genuinely unknown.`;
  const identity=' eventId must be the exact existing event ID the user supplied; never invent or guess one, and ask for it when it is unknown.';
  return {displayName:`${label} · ${calendar.label}`.slice(0,160),
    description:draft+(operation==='delete'?identity:operation==='update'?identity+timing:timing),
    inputSchemaJson:canonicalJson(schema)};
}
