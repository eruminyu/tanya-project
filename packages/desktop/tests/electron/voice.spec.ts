import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopRoot, output, startBrain } from './brain-fixture.js';

function wav(seconds = 1.2) {
  const frames = Math.floor(16000 * seconds), data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(6000 * Math.sin(i / 16000 * Math.PI * 440)), 44 + i * 2);
  return data;
}
async function launch() {
  const env = { ...process.env, KIRIAN_DESKTOP_TEST: '1', KIRIAN_TEST_PROFILE: await mkdtemp(join(output, 'voice-profile-')) };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'KIRIAN_BRAIN_URL', 'KIRIAN_BRAIN_TOKEN', 'KIRIAN_RENDERER_URL']) delete env[key];
  return electron.launch({ cwd: desktopRoot, executablePath: process.env.KIRIAN_PACKAGED_EXE,
    args: [...(process.env.KIRIAN_PACKAGED_EXE ? [] : [desktopRoot]), '--mute-audio', '--use-fake-device-for-media-stream'],
    env, chromiumSandbox: true });
}
async function connect(page: Page, brain: { url: string; token: string }) {
  await page.getByTestId('brain-settings-toggle').click();
  await page.getByTestId('brain-url').fill(brain.url);
  await page.getByTestId('brain-token').fill(brain.token);
  await page.getByTestId('brain-connect').click();
  await expect(page.getByTestId('connection-status')).toHaveText('연결됨');
  await page.getByTestId('brain-settings-toggle').click();
}
async function snapshot(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).kirianDesktop.getSnapshot());
}
async function capture(app: ElectronApplication, name: string) {
  const page = await app.firstWindow();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage(undefined,
    { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(join(output, name), Buffer.from(png, 'base64'));
}

test('Live2D, real Web Audio playback lifecycle, typed interruption and push-to-talk through Python', async () => {
  test.setTimeout(90000);
  let sttBytes = 0, sttType = '', sttCalls = 0;
  const synthesized: string[] = [];
  const upstream = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const body = Buffer.concat(parts);
    if (request.url?.startsWith('/stt/transcriptions')) {
      sttBytes = body.length; sttType = request.headers['content-type'] ?? ''; sttCalls++;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ text: '음성 인식 표본' })); return;
    }
    const query = JSON.parse(body.toString());
    if (request.url === '/tts') {
      synthesized.push(query.text);
      // The second sentence completes generation first; playback must retain text order.
      const delay = query.text.includes('첫 문장') ? 300 : 20;
      await new Promise(resolve => setTimeout(resolve, delay));
      response.setHeader('content-type', 'audio/wav'); response.end(wav()); return;
    }
    const text = query.messages.at(-1).content;
    const answer = text.includes('짧게') ? '짧은 응답이에요.' : '첫 문장이에요. 두 번째 문장이에요. 마지막 문장이에요.) 😊';
    response.setHeader('content-type', 'application/x-ndjson');
    response.end(JSON.stringify({ model: query.model, message: { content: answer }, done: true }) + '\n');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (upstream.address() as { port: number }).port;
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined, app: ElectronApplication | undefined;
  const diagnostics: string[] = [];
  try {
    brain = await startBrain(url, 'voice-fixture', 'local', {
      speech: { model: { provider_id: 'qwen3-tts', model_id: 'fixture-voice', endpoint_id: 'fixture-tts' },
        label: '검증용 합성 파형', url: url + '/tts', boundary: 'local', language: 'Korean', speaker: 'Sohee' },
      transcription: { url: url + '/stt/transcriptions', boundary: 'local', model_label: '검증용 STT' }
    });
    app = await launch(); const page = await app.firstWindow();
    page.on('pageerror', error => diagnostics.push(error.message));
    page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
    await connect(page, brain);
    if (await page.getByTestId('live2d-retry').isVisible()) await page.getByTestId('live2d-retry').click();
    await expect(page.locator('.live2d-stage')).toHaveAttribute('data-state', 'ready', { timeout: 25000 });
    await page.evaluate(() => {
      const w = window as any; w.voiceEvents = [];
      w.kirianDesktop.onAudio((event: any) => w.voiceEvents.push(event.kind === 'audio' ? { kind: event.kind, sentence: event.sentence } : event));
    });
    await page.getByTestId('chat-input').fill('음성 순서 확인'); await page.getByTestId('chat-send').click();
    await expect.poll(async () => (await snapshot(page)).brain.speech.phase).toBe('playing');
    expect((await snapshot(page)).session.activeTurnId).not.toBeNull();
    await expect.poll(async () => Number(await page.locator('.live2d-stage').getAttribute('data-mouth-open'))).toBeGreaterThan(0.05);
    await expect(page.locator('.presence-footer')).toContainText('말하고 있어요');
    await capture(app, 'voice-live2d-playing.png');
    await expect.poll(async () => (await snapshot(page)).session.activeTurnId, { timeout: 15000 }).toBeNull();
    await expect(page.locator('.live2d-stage')).toHaveAttribute('data-mouth-open', '0');
    const sentences = await page.evaluate(() => (window as any).voiceEvents.filter((event: any) => event.kind === 'audio').map((event: any) => event.sentence));
    expect(sentences.join('')).toBe('첫 문장이에요. 두 번째 문장이에요. 마지막 문장이에요.');
    await expect(page.getByTestId('messages')).toContainText('마지막 문장이에요.) 😊');
    expect(synthesized.length).toBeGreaterThan(1);
    await page.getByTestId('chat-input').fill('끼어들기 이전'); await page.getByTestId('chat-send').click();
    await expect.poll(async () => (await snapshot(page)).brain.speech.phase).toBe('playing');
    await page.getByTestId('chat-input').fill('짧게 새 질문'); await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('messages')).toContainText('짧은 응답이에요.');
    await expect.poll(async () => (await snapshot(page)).session.activeTurnId, { timeout: 15000 }).toBeNull();
    await page.getByTestId('brain-settings-toggle').click();
    await page.getByTestId('voice-toggle').click();
    await expect(page.getByTestId('voice-toggle'), JSON.stringify({ state: await snapshot(page),
      notice: await page.getByTestId('app-notice').allTextContents() })).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('microphone-toggle').click();
    await expect(page.getByTestId('microphone-toggle')).toHaveText('녹음 끝내고 보내기');
    // Wait for actual MediaRecorder chunks from Chromium's fake input device.
    await page.waitForTimeout(700);
    await page.getByTestId('microphone-toggle').click();
    await expect(page.getByTestId('messages')).toContainText('음성 인식 표본');
    await expect.poll(async () => (await snapshot(page)).session.activeTurnId).toBeNull();
    expect(sttBytes).toBeGreaterThan(32); expect(sttType).toContain('audio/webm'); expect(sttCalls).toBe(1);
    await page.getByTestId('microphone-toggle').click();
    await expect(page.getByTestId('microphone-toggle')).toHaveText('녹음 끝내고 보내기');
    await page.getByTestId('microphone-cancel').click();
    await expect(page.getByTestId('microphone-toggle')).toHaveText('마이크로 말하기');
    expect(sttCalls).toBe(1);
    // Once disarmed, renderer cannot silently reacquire a microphone.
    const permission = await page.evaluate(async () => {
      try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(track => track.stop()); return 'allowed'; }
      catch { return 'denied'; }
    });
    expect(permission).toBe('denied');
    await page.getByTestId('brain-settings-toggle').click();
    await capture(app, 'voice-live2d-complete.png');
    expect(diagnostics).toEqual([]);
  } finally {
    await writeFile(join(output, 'voice-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
    await app?.close(); await brain?.stop();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test('live selected Gemma and existing Kirian voice complete playback in Electron', async () => {
  test.skip(!process.env.KIRIAN_LIVE_VOICE_CONFIG, 'Explicit private host configuration required');
  test.setTimeout(180000);
  const host = JSON.parse(await readFile(process.env.KIRIAN_LIVE_VOICE_CONFIG!, 'utf8'));
  const binding = host.bindings[0];
  const brain = await startBrain(binding.url, binding.model.model_id, 'private_lan', { speech: host.speech, transcription: host.transcription });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); const page = await app.firstWindow(); await connect(page, brain);
    await expect(page.locator('.live2d-stage')).toHaveAttribute('data-state', 'ready', { timeout: 25000 });
    await page.getByTestId('chat-input').fill('너는 키리안이야. 한국어로 짧게 한 문장만 말해 줘. 음성과 캐릭터가 연결됐다고 인사해 줘.');
    await page.getByTestId('chat-send').click();
    await expect.poll(async () => (await snapshot(page)).brain.speech.phase, { timeout: 120000 }).toBe('playing');
    await capture(app, 'live-kirian-voice.png');
    await expect.poll(async () => (await snapshot(page)).session.activeTurnId, { timeout: 90000 }).toBeNull();
    const result = await snapshot(page);
    await writeFile(join(output, 'live-voice-response.json'), JSON.stringify({ model: result.session.actualModel,
      voice: result.brain.speech.label, error: result.brain.speech.error, answer: result.session.messages.at(-1).text, verifiedAt: new Date().toISOString() }, null, 2));
    expect(result.brain.speech.error).toBeNull(); expect(result.session.messages.at(-1).status).toBe('completed');
  } finally { await app?.close(); await brain.stop(); }
});
