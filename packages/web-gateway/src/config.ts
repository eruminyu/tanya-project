// Gateway settings come from the environment (systemd EnvironmentFile on the VM) or from tests.
// The Brain token is a secret: it is read from a file or a variable and never logged.
import { readFileSync } from 'node:fs';

export interface GatewayLimits {
  /** Visitor sessions one client key may open per hour (sliding window). */
  sessionsPerHour: number;
  /** Concurrent visitor sessions per client key (tabs). */
  concurrentPerClient: number;
  /** Concurrent visitor sessions in the whole gateway. */
  concurrentTotal: number;
  /** Turns that may generate at the same time across all visitors (the VM has one GPU). */
  concurrentTurns: number;
  /** Turns one visitor session may start. */
  turnsPerSession: number;
  /** Characters of one visitor message. */
  messageCharacters: number;
  /** How far ahead an approved event yields a proactive card (the desktop uses 15; the demo is more forgiving). */
  proactiveLeadMinutes: number;
  /** Seconds without a turn before the session closes. */
  idleSeconds: number;
  /** Seconds a session may live regardless of activity. */
  sessionSeconds: number;
  /** Seconds a visitor token stays valid before the socket is opened. */
  tokenSeconds: number;
}

export interface GatewayConfig {
  host: string;
  port: number;
  brainUrl: string;
  brainToken: string;
  staticDir: string | null;
  /** Trust cf-connecting-ip / x-forwarded-for from the reverse proxy in front of the gateway. */
  trustProxy: boolean;
  /** Presentation of the calendar the drafts are made for (the visitor's own calendar for the hand-off). */
  calendarLabel: string;
  calendarTimeZone: string;
  /** 'handoff' prepares links for the visitor's own calendar; 'google_demo' writes to a public demo calendar. */
  executorKind: 'handoff' | 'google_demo';
  googleDemo: { credentialFile: string; calendarId: string; cleanupMinutes: number } | null;
  limits: GatewayLimits;
}

export const DEFAULT_LIMITS: GatewayLimits = {
  sessionsPerHour: 20, concurrentPerClient: 2, concurrentTotal: 40, concurrentTurns: 2,
  turnsPerSession: 30, messageCharacters: 500, proactiveLeadMinutes: 30, idleSeconds: 600, sessionSeconds: 3600, tokenSeconds: 60,
};

function integer(name: string, fallback: number, minimum: number, maximum: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('invalid_gateway_setting:' + name);
  return value;
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) throw new Error('gateway_setting_required:' + name);
  return value;
}

function timeZone(value: string): string {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return value; } catch { throw new Error('invalid_gateway_setting:KIRIAN_GATEWAY_CALENDAR_TIMEZONE'); }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const tokenFile = env.KIRIAN_GATEWAY_BRAIN_TOKEN_FILE;
  const brainToken = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : (env.KIRIAN_GATEWAY_BRAIN_TOKEN ?? '');
  if (brainToken.length < 32) throw new Error('gateway_brain_token_required');
  const brainUrl = env.KIRIAN_GATEWAY_BRAIN_URL ?? 'http://127.0.0.1:8099';
  const parsed = new URL(brainUrl);
  // The Brain only accepts loopback clients; anything else would fail authentication anyway.
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('gateway_brain_url_must_be_loopback');
  const executorKind = env.KIRIAN_GATEWAY_EXECUTOR ?? 'handoff';
  if (executorKind !== 'handoff' && executorKind !== 'google_demo') throw new Error('invalid_gateway_setting:KIRIAN_GATEWAY_EXECUTOR');
  return {
    host: env.KIRIAN_GATEWAY_HOST ?? '127.0.0.1',
    port: integer('KIRIAN_GATEWAY_PORT', 8090, 1, 65535, env),
    brainUrl: parsed.origin + '/',
    brainToken,
    staticDir: env.KIRIAN_GATEWAY_STATIC_DIR || null,
    trustProxy: env.KIRIAN_GATEWAY_TRUST_PROXY === '1',
    calendarLabel: env.KIRIAN_GATEWAY_CALENDAR_LABEL ?? '내 캘린더',
    calendarTimeZone: timeZone(env.KIRIAN_GATEWAY_CALENDAR_TIMEZONE ?? 'Asia/Seoul'),
    executorKind,
    googleDemo: executorKind === 'google_demo' ? {
      credentialFile: required('KIRIAN_GATEWAY_GOOGLE_DEMO_CREDENTIAL_FILE', env), calendarId: required('KIRIAN_GATEWAY_GOOGLE_DEMO_CALENDAR_ID', env),
      cleanupMinutes: integer('KIRIAN_GATEWAY_GOOGLE_DEMO_CLEANUP_MINUTES', 60, 1, 1440, env) } : null,
    limits: {
      sessionsPerHour: integer('KIRIAN_GATEWAY_SESSIONS_PER_HOUR', DEFAULT_LIMITS.sessionsPerHour, 1, 100000, env),
      concurrentPerClient: integer('KIRIAN_GATEWAY_CONCURRENT_PER_CLIENT', DEFAULT_LIMITS.concurrentPerClient, 1, 1000, env),
      concurrentTotal: integer('KIRIAN_GATEWAY_CONCURRENT_TOTAL', DEFAULT_LIMITS.concurrentTotal, 1, 10000, env),
      concurrentTurns: integer('KIRIAN_GATEWAY_CONCURRENT_TURNS', DEFAULT_LIMITS.concurrentTurns, 1, 100, env),
      turnsPerSession: integer('KIRIAN_GATEWAY_TURNS_PER_SESSION', DEFAULT_LIMITS.turnsPerSession, 1, 10000, env),
      messageCharacters: integer('KIRIAN_GATEWAY_MESSAGE_CHARACTERS', DEFAULT_LIMITS.messageCharacters, 1, 4000, env),
      proactiveLeadMinutes: integer('KIRIAN_GATEWAY_PROACTIVE_LEAD_MINUTES', DEFAULT_LIMITS.proactiveLeadMinutes, 1, 1440, env),
      idleSeconds: integer('KIRIAN_GATEWAY_IDLE_SECONDS', DEFAULT_LIMITS.idleSeconds, 10, 86400, env),
      sessionSeconds: integer('KIRIAN_GATEWAY_SESSION_SECONDS', DEFAULT_LIMITS.sessionSeconds, 10, 86400, env),
      tokenSeconds: integer('KIRIAN_GATEWAY_TOKEN_SECONDS', DEFAULT_LIMITS.tokenSeconds, 5, 3600, env),
    },
  };
}
