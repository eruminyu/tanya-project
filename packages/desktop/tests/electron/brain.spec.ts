import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopRoot, output, startBrain } from './brain-fixture.js';

async function launch() {
  const env = {
    ...process.env,
    KIRIAN_DESKTOP_TEST: '1',
    KIRIAN_TEST_PROFILE: await mkdtemp(join(output, 'e2e-profile-')),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.KIRIAN_BRAIN_URL;
  delete env.KIRIAN_BRAIN_TOKEN;
  delete env.KIRIAN_RENDERER_URL;
  const packaged = process.env.KIRIAN_PACKAGED_EXE;
  return electron.launch({
    cwd: desktopRoot,
    args: packaged ? [] : [desktopRoot],
    executablePath: packaged,
    env,
    chromiumSandbox: true,
  });
}
async function capture(app: ElectronApplication, name: string) {
  const page = await app.firstWindow();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (
      await BrowserWindow.getAllWindows()[0].capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      })
    )
      .toPNG()
      .toString('base64')
  );
  await writeFile(join(output, name), Buffer.from(png, 'base64'));
}
async function connect(page: any, brain: { url: string; token: string }) {
  await page.getByTestId('brain-settings-toggle').click();
  await page.getByTestId('brain-url').fill(brain.url);
  await page.getByTestId('brain-token').fill(brain.token);
  await page.getByTestId('brain-connect').click();
  await expect(page.getByTestId('connection-status')).toHaveText('연결됨');
  await expect(page.getByTestId('brain-token')).toHaveValue('');
  await page.getByTestId('brain-settings-toggle').click();
  await expect(page.getByTestId('chat-input')).toBeEnabled();
}
test('Electron → authenticated Python Brain → HTTP streaming provider, cancel, failure and reconnect', async () => {
  // The integrated character render loop makes hidden-window UI actions wait for
  // Chromium's background frame cadence; retain the complete connection regression.
  test.setTimeout(60000);
  let cancelled = false;
  const upstream = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const query = JSON.parse(body),
      text = query.messages.at(-1).content,
      model = query.model;
    if (text.includes('오류')) {
      response.writeHead(503).end('PRIVATE-UPSTREAM-DETAIL');
      return;
    }
    response.setHeader('content-type', 'application/x-ndjson');
    if (text.includes('중단')) {
      response.write(
        JSON.stringify({
          model,
          message: { content: '[검증 표본] 응답 시작' },
          done: false,
        }) + '\n'
      );
      const timer = setTimeout(
        () =>
          response.end(
            JSON.stringify({
              model,
              message: { content: '늦은 응답' },
              done: true,
            }) + '\n'
          ),
        5000
      );
      response.on('close', () => {
        cancelled = true;
        clearTimeout(timer);
      });
      return;
    }
    response.write(
      JSON.stringify({
        model,
        message: { content: '[검증 표본] 연결 성공' },
        done: false,
      }) + '\n'
    );
    response.end(
      JSON.stringify({ model, message: { content: '' }, done: true }) + '\n'
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve)
  );
  const upstreamPort = (upstream.address() as { port: number }).port;
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined,
    app: ElectronApplication | undefined;
  try {
    brain = await startBrain(
      'http://127.0.0.1:' + upstreamPort,
      'fixture-model'
    );
    app = await launch();
    const page = await app.firstWindow();
    await connect(page, brain);
    await page.getByTestId('chat-input').fill('연결 확인');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('messages')).toContainText(
      '[검증 표본] 연결 성공'
    );
    await expect(page.getByTestId('actual-model')).toHaveText('fixture-model');
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    const modelSelect = page.getByTestId('model-select');
    await modelSelect.selectOption({ index: 1 });
    await page.getByTestId('chat-input').fill('대화 모델 확인');
    await page.getByTestId('chat-send').click();
    await expect(page.locator('.message-assistant')).toHaveCount(2);
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    await modelSelect.selectOption({ index: 0 });
    await page.getByTestId('chat-input').fill('기본 모델 복귀 확인');
    await page.getByTestId('chat-send').click();
    await expect(page.locator('.message-assistant')).toHaveCount(3);
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    await expect(page.getByTestId('messages')).not.toContainText('실패');
    await page.getByTestId('chat-input').fill('중단 확인');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('messages')).toContainText('응답 시작');
    await page.getByTestId('turn-cancel').click();
    await expect(page.getByTestId('messages')).toContainText('중단됨');
    await expect.poll(() => cancelled).toBe(true);
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    await page.getByTestId('chat-input').fill('오류 확인');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('messages')).toContainText('실패');
    await expect(page.getByTestId('messages')).not.toContainText(
      'PRIVATE-UPSTREAM-DETAIL'
    );
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    await page.getByTestId('brain-settings-toggle').click();
    await page.getByTestId('brain-reconnect').click();
    await expect(page.getByTestId('connection-status')).toHaveText('연결됨');
    await page.getByTestId('brain-settings-toggle').click();
    await expect(page.getByTestId('messages')).toContainText(
      '[검증 표본] 연결 성공'
    );
    await capture(app, 'brain-integration.png');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(560, 640)
    );
    await page.getByTestId('brain-settings-toggle').click();
    await expect(page.getByTestId('brain-disconnect')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
    await capture(app, 'brain-settings-compact.png');
  } finally {
    await app?.close();
    await brain?.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
test('live user-selected Ollama responds inside Electron', async () => {
  test.skip(
    !process.env.KIRIAN_LIVE_OLLAMA_URL || !process.env.KIRIAN_LIVE_OLLAMA_MODEL,
    'Live endpoint explicitly configured separately'
  );
  test.setTimeout(120000);
  const model = process.env.KIRIAN_LIVE_OLLAMA_MODEL!;
  const brain = await startBrain(
    process.env.KIRIAN_LIVE_OLLAMA_URL!,
    model,
    'private_lan'
  );
  let app: ElectronApplication | undefined;
  try {
    app = await launch();
    const page = await app.firstWindow();
    await connect(page, brain);
    await page
      .getByTestId('chat-input')
      .fill(
        '한국어로 한 문장만 답해줘. 너의 이름은 키리안이야. 연결이 잘 됐다고 인사해줘.'
      );
    await page.getByTestId('chat-send').click();
    const assistantMessage = page.locator('.message-assistant').last();
    const response = assistantMessage.locator('.message-bubble > p').first();
    await expect(response).not.toHaveText('', { timeout: 90000 });
    await expect(page.getByTestId('turn-cancel')).toHaveCount(0, {
      timeout: 90000,
    });
    await expect(assistantMessage.locator('.message-status')).toHaveCount(0);
    await expect(page.getByTestId('chat-input')).toBeEnabled({
      timeout: 90000,
    });
    await expect(page.getByTestId('actual-model')).toHaveText(model);
    await expect(page.getByTestId('messages')).not.toContainText('실패');
    const answer = await response.textContent();
    await writeFile(
      join(output, 'live-response.json'),
      JSON.stringify(
        { model, answer, verifiedAt: new Date().toISOString() },
        null,
        2
      )
    );
    await capture(app, 'live-conversation.png');
  } finally {
    await app?.close();
    await brain.stop();
  }
});
