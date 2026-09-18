// Captures README screenshots from the live public demo with a real (headed-capable) Chromium: main screen,
// a voiced reply, a calendar draft card, and the receipt after approval. Ends the session with "체험 끝내기"
// so the demo events it created are deleted immediately. Usage: node tools/public-snapshot/screenshots.mjs [url]
import { chromium } from '../../packages/desktop/node_modules/playwright/index.mjs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const url = process.argv[2] ?? 'https://tanya.serian.live/';
const out = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url));
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, locale: 'ko-KR' });
const shot = async (name) => { await page.screenshot({ path: out + name, fullPage: false }); console.log('saved', name); };
const send = async (text) => {
  await page.getByPlaceholder(/이야기해 주세요/).fill(text);
  await page.getByRole('button', { name: '메시지 보내기' }).click();
};
const idle = async (timeout = 90_000) => {
  await page.getByText('답변을 생성하고 있어요').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
  await page.getByText('답변을 생성하고 있어요').waitFor({ state: 'hidden', timeout });
};

await page.goto(url, { waitUntil: 'networkidle' });
await page.getByText('Live2D 연결됨').waitFor({ timeout: 60_000 });
await page.getByText('연결됨', { exact: true }).waitFor({ timeout: 60_000 });
await page.waitForTimeout(2500);
await shot('01-main.png');

await send('안녕, 너는 누구야? 두 문장으로 소개해 줘.');
await page.getByText('타냐', { exact: true }).first().waitFor();
await page.waitForTimeout(6000); // caption + lip-sync while the first sentences play
await shot('02-voice-reply.png');
await idle();

await send('내일 오후 3시에 운동 일정 추가해 줘.');
const approve = page.getByRole('button', { name: /승인하고/ });
try { await approve.waitFor({ timeout: 60_000 }); }
catch { await idle(); await send('응, 그대로 초안 준비해 줘.'); await approve.waitFor({ timeout: 60_000 }); }
await page.waitForTimeout(800);
await shot('03-draft-card.png');

await approve.click();
await page.getByText('재조회 확인됨').waitFor({ timeout: 60_000 });
await idle();
await page.waitForTimeout(1000);
await shot('04-receipt.png');

const finish = page.getByRole('button', { name: /체험 끝내기/ });
if (await finish.count()) { await finish.click(); await page.waitForTimeout(4000); console.log('finished session (demo events deleted)'); }
await browser.close();
