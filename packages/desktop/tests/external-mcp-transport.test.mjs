import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { McpClient, McpTransportError } from '../src/main/external/mcp-transport.ts';

const stdioFixture = fileURLToPath(new URL('./fixtures/external-mcp-stdio.mjs', import.meta.url));
const tool = { name: 'fixture_tool', description: 'untrusted description', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } };
const initialize = version => ({ protocolVersion: version ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
const rpc = (res, id, result, headers = {}) => {
  res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
};
const isCode = (code, sent) => error => {
  assert(error instanceof McpTransportError);
  assert.equal(error.code, code);
  if (sent !== undefined) assert.equal(error.requestSent, sent);
  assert(!error.message.includes('secret'));
  return true;
};
async function httpFixture(t, handler, options = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ method: req.method, headers: req.headers, body });
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    if (body?.method === 'initialize' && !options.customInitialize) { rpc(res, body.id, initialize(options.version), { 'Mcp-Session-Id': 'fixture-session' }); return; }
    if (body && !Object.hasOwn(body, 'id')) { res.writeHead(202); res.end(); return; }
    await handler(req, res, body, requests);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const client = new McpClient({ kind: 'http', url }, options.clientOptions);
  t.after(async () => { client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { client, requests, url };
}
function stdio(t, mode = 'normal', options) {
  const client = new McpClient({ kind: 'stdio', command: process.execPath, args: [stdioFixture, mode] }, options);
  t.after(() => client.close());
  return client;
}

test('stdio negotiates, lists and calls a real fixture without inheriting secrets or stderr', async t => {
  const previous = process.env.KIRIAN_MCP_TEST_SECRET;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.KIRIAN_MCP_TEST_SECRET = 'fixture-secret';
  process.env.NODE_OPTIONS = '--no-warnings';
  t.after(() => { if (previous === undefined) delete process.env.KIRIAN_MCP_TEST_SECRET; else process.env.KIRIAN_MCP_TEST_SECRET = previous; });
  t.after(() => { if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousNodeOptions; });
  const client = stdio(t);
  await client.connect();
  assert.deepEqual(await client.listTools(), [{ name: 'echo', inputSchema: { type: 'object' } }]);
  const result = await client.callTool('echo', { greeting: '한글\nvalue' });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0].text), { args: { greeting: '한글\nvalue' }, secret: null, nodeOptions: null });
  assert.deepEqual(result.structuredContent, { fixture: true });
  assert.equal(typeof result.requestId, 'string');
});

test('HTTP negotiation sends session/version headers and accumulates paginated tools', async t => {
  const f = await httpFixture(t, (_req, res, body) => rpc(res, body.id, {
    tools: [{ ...tool, name: body.params.cursor ? 'second' : 'first' }], ...(body.params.cursor ? {} : { nextCursor: 'page-2' }),
  }), { version: '2025-06-18' });
  await f.client.connect();
  const result = await f.client.listTools();
  assert.deepEqual(result.map(value => value.name), ['first', 'second']);
  assert.equal(result[0].readOnlyHint, true);
  assert.equal(f.requests[0].body.params.protocolVersion, '2025-11-25');
  assert.deepEqual(f.requests[0].body.params.capabilities, {});
  for (const request of f.requests.slice(1)) {
    assert.equal(request.headers['mcp-session-id'], 'fixture-session');
    assert.equal(request.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(request.headers.authorization, undefined);
  }
});

test('HTTP SSE handles split Unicode, CRLF and untrusted server requests without executing them', async t => {
  let refused = false;
  const f = await httpFixture(t, (_req, res, body) => {
    if (!body.method) {
      assert.equal(body.error.code, -32601);
      refused = true;
      res.writeHead(202); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const stream = ': keepalive\r\n\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 'server-1', method: 'sampling/createMessage', params: { secret: 'ignore me' } }) + '\r\n\r\n'
      + 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '한글' }], isError: false } }) + '\r\n\r\n';
    const bytes = Buffer.from(stream); const split = bytes.indexOf(Buffer.from('한')) + 1;
    res.write(bytes.subarray(0, split)); res.end(bytes.subarray(split));
  });
  await f.client.connect();
  const result = await f.client.callTool('fixture_tool', {});
  assert.equal(result.content[0].text, '한글');
  assert.equal(refused, true);
  assert.equal(f.requests.filter(request => request.body?.method === 'tools/call').length, 1);
});

test('provider tool error remains a concrete isError result', async t => {
  const f = await httpFixture(t, (_req, res, body) => rpc(res, body.id, { isError: true, content: [{ type: 'text', text: 'fixture refusal' }] }));
  await f.client.connect();
  assert.equal((await f.client.callTool('fixture_tool', {})).isError, true);
});

for (const [mode, code] of [['version', 'unsupported_protocol'], ['bad-json', 'protocol_error'], ['hang-initialize', 'timeout']]) {
  test(`stdio initialization rejects ${mode}`, async t => {
    const client = stdio(t, mode, { requestTimeoutMs: 1500 });
    await assert.rejects(client.connect(), isCode(code));
    await assert.rejects(client.callTool('echo', {}), isCode('not_connected', false));
  });
}

for (const [mode, code] of [['exit', 'disconnected'], ['hang', 'timeout'], ['oversize', 'limit_exceeded']]) {
  test(`stdio sent tool call rejects ${mode} without replay`, async t => {
    // 전체 회귀의 동시 Node/PowerShell 시작 부하에서도 실제 자식 초기화를 기다린다.
    const client = stdio(t, mode, { requestTimeoutMs: 1500, maxMessageBytes: 2000 });
    await client.connect();
    await assert.rejects(client.callTool('echo', {}), isCode(code, true));
  });
}

test('a late stdio result after timeout is ignored without replaying the call or closing the connection', async t => {
  const events = [];
  const client = stdio(t, 'late-once', { requestTimeoutMs: 1500, onDisconnected: error => events.push(error) });
  await client.connect();
  await assert.rejects(client.callTool('echo', {}), isCode('timeout', true));
  const result = await client.callTool('echo', {});
  assert.equal(result.content[0].text, '2');
  assert.deepEqual(events, []);
});

test('aborting before a call sends zero requests; aborting during a call reports sent and never retries', async t => {
  const f = await httpFixture(t, () => {});
  await f.client.connect();
  const before = new AbortController(); before.abort();
  await assert.rejects(f.client.callTool('fixture_tool', {}, before.signal), isCode('aborted', false));
  const during = new AbortController();
  const running = f.client.callTool('fixture_tool', {}, during.signal);
  setTimeout(() => during.abort(), 40);
  await assert.rejects(running, isCode('aborted', true));
  assert.equal(f.requests.filter(request => request.body?.method === 'tools/call').length, 1);
});

test('close interrupts an in-flight request and never reconnects automatically', async t => {
  const client = stdio(t, 'hang');
  await client.connect();
  const pending = client.callTool('echo', {});
  client.close();
  await assert.rejects(pending, isCode('disconnected', true));
  await assert.rejects(client.listTools(), isCode('not_connected', false));
});

test('natural stdio disconnect notifies once and callback closure does not recurse', { timeout: 3000 }, async t => {
  const events = [];
  const client = stdio(t, 'exit', { onDisconnected: error => { events.push(error); client.close(); } });
  await client.connect();
  await assert.rejects(client.callTool('echo', {}), isCode('disconnected', true));
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 'disconnected');
});

test('explicit stdio close does not emit an unexpected disconnect callback', async t => {
  const events = [];
  const client = stdio(t, 'normal', { onDisconnected: error => events.push(error) });
  await client.connect(); client.close();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(events, []);
});

test('HTTP transport failure invalidates the session and notifies once', async t => {
  const events = [];
  const f = await httpFixture(t, (req) => req.socket.destroy(), { clientOptions: { onDisconnected: error => events.push(error) } });
  await f.client.connect();
  await assert.rejects(f.client.callTool('fixture_tool', {}), isCode('disconnected', true));
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 'disconnected');
  await assert.rejects(f.client.listTools(), isCode('not_connected', false));
});

test('an earlier initialization cannot close a newly requested connection', async t => {
  let seen;
  const entered = new Promise(resolve => { seen = resolve; });
  let first = true;
  const f = await httpFixture(t, (_req, res, body) => {
    if (body.method === 'initialize') {
      if (first) { first = false; seen(); return; }
      rpc(res, body.id, initialize(), { 'Mcp-Session-Id': 'new-session' }); return;
    }
    rpc(res, body.id, { tools: [tool] });
  }, { customInitialize: true });
  const old = f.client.connect();
  const oldRejected = assert.rejects(old, isCode('disconnected', true));
  await entered;
  f.client.close();
  await f.client.connect();
  await oldRejected;
  assert.equal((await f.client.listTools()).length, 1);
});

test('a well-formed JSON-RPC error is distinct from an invalid error response', async t => {
  let malformed = false;
  const f = await httpFixture(t, (_req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: malformed ? 'secret' : { code: -32602, message: 'secret' } }));
  });
  await f.client.connect();
  await assert.rejects(f.client.callTool('fixture_tool', {}), isCode('rpc_error', true));
  malformed = true;
  await assert.rejects(f.client.callTool('fixture_tool', {}), isCode('protocol_error', true));
});

test('invalid UTF-8 is a protocol error without exposing server bytes', async t => {
  const f = await httpFixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(Buffer.from([0xff, 0xfe]));
  });
  await f.client.connect();
  await assert.rejects(f.client.callTool('fixture_tool', {}), isCode('protocol_error', true));
});

test('tools capability is required before tool I/O', async t => {
  const f = await httpFixture(t, (_req, res, body) => rpc(res, body.id, { ...initialize(), capabilities: {} }), { customInitialize: true });
  await f.client.connect();
  await assert.rejects(f.client.callTool('fixture_tool', {}), isCode('unsupported_capability', false));
  assert.equal(f.requests.filter(request => request.body?.method === 'tools/call').length, 0);
});

for (const [status, code] of [[401, 'auth_required'], [403, 'auth_required'], [500, 'http_error'], [404, 'session_expired']]) {
  test(`HTTP ${status} is sanitized, typed and never replays a tool call`, async t => {
    const f = await httpFixture(t, (_req, res) => { res.writeHead(status); res.end('fixture-server-secret'); });
    await f.client.connect();
    await assert.rejects(f.client.callTool('fixture_tool', {}), isCode(code, true));
    assert.equal(f.requests.filter(request => request.body?.method === 'tools/call').length, 1);
    assert.equal(f.requests.filter(request => request.body?.method === 'initialize').length, 1);
  });
}

test('HTTP redirect never follows an unapproved endpoint', async t => {
  let targetCalls = 0;
  const target = await httpFixture(t, (_req, res) => { targetCalls++; res.end(); });
  const f = await httpFixture(t, (_req, res) => { res.writeHead(307, { Location: target.url }); res.end(); });
  await f.client.connect();
  await assert.rejects(f.client.callTool('fixture_tool', {}), isCode('http_error', true));
  assert.equal(targetCalls, 0);
});

for (const variant of ['duplicate', 'cursor-loop', 'pages', 'tools']) {
  test(`tool listing enforces ${variant} bounds`, async t => {
    const f = await httpFixture(t, (_req, res, body) => {
      const result = variant === 'duplicate' ? { tools: [tool, tool] }
        : variant === 'tools' ? { tools: [tool, { ...tool, name: 'second' }] }
        : { tools: [{ ...tool, name: body.params.cursor ?? 'first' }], nextCursor: variant === 'cursor-loop' ? 'loop' : crypto.randomUUID() };
      rpc(res, body.id, result);
    }, { clientOptions: { maxPages: 2, maxTools: variant === 'tools' ? 1 : 10 } });
    await f.client.connect();
    await assert.rejects(f.client.listTools(), isCode(variant === 'duplicate' || variant === 'cursor-loop' ? 'protocol_error' : 'limit_exceeded'));
  });
}

test('tool listing stops before transmitting another page after its total deadline', async t => {
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  const url = 'https://mcp-fixture.invalid/deadline', requests = [];
  t.mock.method(globalThis, 'fetch', async (target, init) => {
    assert.equal(target, url);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    const body = JSON.parse(init.body); requests.push(body);
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: initialize() });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(body.method, 'tools/list');
    now += 101;
    return Response.json({ jsonrpc: '2.0', id: body.id, result: {
      tools: [{ ...tool, name: body.params.cursor ?? 'first' }], ...(body.params.cursor ? {} : { nextCursor: 'second' }),
    } });
  });
  const client = new McpClient({ kind: 'http', url }, { requestTimeoutMs: 100 });
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.listTools(), isCode('timeout', false));
  assert.equal(requests.filter(request => request.method === 'tools/list').length, 1);
});

for (const variant of ['large-json', 'large-sse', 'malformed', 'wrong-id', 'truncated-sse', 'changed-session', 'invalid-result']) {
  test(`HTTP rejects ${variant} safely`, async t => {
    const f = await httpFixture(t, (_req, res, body) => {
      if (variant === 'large-json') { rpc(res, body.id, { content: [{ type: 'text', text: 'x'.repeat(3000) }] }); return; }
      if (variant === 'large-sse') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(': ' + 'x'.repeat(3000)); return; }
      if (variant === 'malformed') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('secret'); return; }
      if (variant === 'wrong-id') { rpc(res, 'wrong-id', { content: [] }); return; }
      if (variant === 'truncated-sse') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {}'); return; }
      if (variant === 'changed-session') { rpc(res, body.id, { content: [] }, { 'Mcp-Session-Id': 'other-session' }); return; }
      rpc(res, body.id, { content: 'not an array' });
    }, { clientOptions: { maxMessageBytes: 2000 } });
    await f.client.connect();
    await assert.rejects(f.client.callTool('fixture_tool', {}), isCode(variant.startsWith('large-') ? 'limit_exceeded' : 'protocol_error', true));
  });
}

test('invalid configuration and unconnected use perform no transport I/O', async () => {
  assert.throws(() => new McpClient({kind:'stdio',command:process.execPath,args:[],shell:true}), isCode('invalid_config',false));
  assert.throws(() => new McpClient({kind:'http',url:'https://example.com/mcp',headers:{Authorization:'fixture-secret'}}), isCode('invalid_config',false));
  for (const url of ['file:///tmp/x', 'https://user:secret@example.com/mcp', 'http://example.com/mcp', 'https://example.com/mcp#token']) {
    assert.throws(() => new McpClient({ kind: 'http', url }), isCode('invalid_config', false));
  }
  const client = new McpClient({ kind: 'http', url: 'https://example.com/mcp' });
  await assert.rejects(client.listTools(), isCode('not_connected', false));
  await assert.rejects(client.callTool('fixture_tool', {}), isCode('not_connected', false));
});
