// One-time operator command (run on a PC, never on the VM): authorizes the demo Google account through the
// desktop's loopback OAuth flow and writes the credential JSON the gateway's google_demo executor reads.
// Usage: node dist/web-gateway/src/authorize.js --client-id <id> [--client-secret <secret>] --out <file>
import { writeFile } from 'node:fs/promises';
import { GoogleCalendarAccount, type CredentialStore } from '../../desktop/src/main/external/google-calendar.js';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index] ?? '', process.argv[index + 1] ?? '');
const clientId = args.get('--client-id'), clientSecret = args.get('--client-secret'), out = args.get('--out');
if (!clientId || !out) { console.error('usage: authorize --client-id <id> [--client-secret <secret>] --out <credential.json>'); process.exit(2); }

const store = new Map<string, string>();
const vault: CredentialStore = { async get(key) { return store.get(key) ?? null; }, async set(key, value) { store.set(key, value); }, async delete(key) { store.delete(key); } };
const account = await GoogleCalendarAccount.authorize({ clientId, ...(clientSecret ? { clientSecret } : {}) }, {
  vault,
  openBrowser: async url => { console.log('\n브라우저에서 아래 주소를 열어 데모 계정으로 로그인하고 허용하세요:\n\n' + url + '\n'); },
  authorizationTimeoutMs: 600_000,
});
const credential = [...store.values()][0];
if (!credential) { console.error('authorization produced no credential'); process.exit(1); }
await writeFile(out, credential, { mode: 0o600 });
const calendars = await account.listCalendars();
console.log(`authorized ${account.label}; credential written to ${out}`);
console.log('writable calendars:');
for (const calendar of calendars.filter(item => item.canWrite)) console.log(`  ${calendar.id}  (${calendar.label}, ${calendar.timeZone})`);
console.log('Copy the credential file to the VM (mode 0600) and set KIRIAN_GATEWAY_GOOGLE_DEMO_CALENDAR_ID to the demo calendar id.');
