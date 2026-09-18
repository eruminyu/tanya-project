import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

export type McpConnectionConfig =
  | { kind: 'stdio'; command: string; args: string[] }
  | { kind: 'http'; url: string };

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** 서버가 제공한 비신뢰 힌트이며 승인 생략의 근거가 아니다. */
  readOnlyHint?: boolean;
}

export interface McpCallResult {
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
  requestId: string;
}

export type McpTransportErrorCode = 'invalid_config' | 'not_connected' | 'connection_busy'
  | 'disconnected' | 'aborted' | 'timeout' | 'protocol_error' | 'unsupported_protocol'
  | 'unsupported_capability' | 'auth_required' | 'http_error' | 'session_expired'
  | 'limit_exceeded' | 'rpc_error';

const messages: Record<McpTransportErrorCode, string> = {
  invalid_config: 'MCP 연결 설정 또는 입력값이 올바르지 않습니다.',
  not_connected: 'MCP 서버에 명시적으로 연결해야 합니다.',
  connection_busy: 'MCP 연결 또는 요청이 이미 진행 중입니다.',
  disconnected: 'MCP 연결이 종료되어 결과를 확인할 수 없습니다.',
  aborted: 'MCP 요청 대기를 취소했습니다. 서버의 실행 취소를 보장하지 않습니다.',
  timeout: 'MCP 응답 제한 시간을 초과했습니다. 서버의 실행 취소를 보장하지 않습니다.',
  protocol_error: 'MCP 서버 응답이 지원하는 프로토콜 형식과 일치하지 않습니다.',
  unsupported_protocol: 'MCP 초기화 기반 버전 2025-11-25, 2025-06-18, 2025-03-26만 지원합니다.',
  unsupported_capability: 'MCP 서버가 도구 기능을 제공하지 않습니다.',
  auth_required: '이 MCP 서버의 인증 연결은 지원하지 않습니다. 인증이 필요 없는 명시적 서버를 사용하세요.',
  http_error: 'MCP HTTP 요청이 거부되거나 실패했습니다. 자동 재전송하지 않습니다.',
  session_expired: 'MCP 세션이 만료되었습니다. 다시 연결한 뒤 새 작업을 검토해야 합니다.',
  limit_exceeded: 'MCP 메시지·도구 목록 또는 요청 수 제한을 초과했습니다.',
  rpc_error: 'MCP 서버가 프로토콜 오류 응답을 반환했습니다.',
};

export class McpTransportError extends Error {
  readonly code: McpTransportErrorCode;
  readonly requestId?: string;
  /** 전송을 시도했다는 뜻이다. 서버 수신이나 실행 성공의 증거가 아니다. */
  readonly requestSent: boolean;
  constructor(code: McpTransportErrorCode, requestId?: string, requestSent = false) {
    super(messages[code]);
    this.name = 'McpTransportError';
    this.code = code;
    this.requestId = requestId;
    this.requestSent = requestSent;
  }
}

export interface McpClientOptions {
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  maxPages?: number;
  maxTools?: number;
  /** main의 연결 상태 갱신 전용. 명시적 close()에는 호출하지 않는다. */
  onDisconnected?: (error: McpTransportError) => void;
}

type JsonObject = Record<string, unknown>;
type RequestContext = {
  id: string;
  sent: boolean;
  bytes: number;
  controller: AbortController;
  resolve?: (value: JsonObject) => void;
};

const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const object = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const toolName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const own = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
function limit(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new McpTransportError('invalid_config');
  return value;
}

/** main 전용. 인증 토큰·부모 프로세스 비밀 환경변수는 전달하지 않는다. */
function minimalEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp']);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toLowerCase()) && value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * 명시적으로 선택한 stdio/Streamable HTTP 서버만 연결한다.
 * 초기화 기반 MCP만 지원하며 OAuth, 구 HTTP+SSE, task 실행, 자동 재연결·재전송은 지원하지 않는다.
 * 서버의 설명·instructions·notification은 실행 지시로 처리하지 않는다.
 */
export class McpClient {
  readonly #config: McpConnectionConfig;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #maxPages: number;
  readonly #maxTools: number;
  readonly #onDisconnected?: (error: McpTransportError) => void;
  #state: 'idle' | 'connecting' | 'connected' | 'closed' = 'idle';
  #life = new AbortController();
  #child?: ChildProcessByStdio<Writable, Readable, null>;
  #pending = new Map<string, RequestContext>();
  #retired = new Set<string>();
  #stdout = Buffer.alloc(0);
  #idleBytes = 0;
  #version?: string;
  #session?: string;
  #hasTools = false;

  constructor(config: McpConnectionConfig, options: McpClientOptions = {}) {
    this.#timeoutMs = limit(options.requestTimeoutMs, 30_000, 10, 120_000);
    this.#maxBytes = limit(options.maxMessageBytes, 1_048_576, 512, 4_194_304);
    this.#maxPages = limit(options.maxPages, 16, 1, 64);
    this.#maxTools = limit(options.maxTools, 256, 1, 1024);
    if (options.onDisconnected !== undefined && typeof options.onDisconnected !== 'function') throw new McpTransportError('invalid_config');
    this.#onDisconnected = options.onDisconnected;
    if (!object(config)) throw new McpTransportError('invalid_config');
    if (Object.keys(config).sort().join() !== (config.kind === 'stdio' ? 'args,command,kind' : 'kind,url'))
      throw new McpTransportError('invalid_config');
    if (config.kind === 'stdio') {
      if (typeof config.command !== 'string' || !config.command.trim() || config.command.length > 4096 || config.command.includes('\0')
        || !Array.isArray(config.args) || config.args.length > 128
        || config.args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))
        || Buffer.byteLength(JSON.stringify(config)) > 65_536) throw new McpTransportError('invalid_config');
      this.#config = { kind: 'stdio', command: config.command, args: [...config.args] };
    } else if (config.kind === 'http') {
      let url: URL;
      try { url = new URL(config.url); } catch { throw new McpTransportError('invalid_config'); }
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (config.url.length > 4096 || url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
        throw new McpTransportError('invalid_config');
      }
      this.#config = { kind: 'http', url: url.href };
    } else throw new McpTransportError('invalid_config');
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new McpTransportError('aborted');
    if (this.#state === 'connecting') throw new McpTransportError('connection_busy');
    if (this.#state === 'connected') return;
    this.#state = 'connecting';
    this.#life = new AbortController();
    const connectionLife = this.#life;
    this.#version = undefined;
    this.#session = undefined;
    this.#hasTools = false;
    this.#stdout = Buffer.alloc(0);
    this.#idleBytes = 0;
    try {
      if (this.#config.kind === 'stdio') this.#startChild();
      const { result, requestId } = await this.#request('initialize', {
        protocolVersion: versions[0], capabilities: {}, clientInfo: { name: 'kirian-desktop', version: '0.1.0' },
      }, signal);
      if (this.#life !== connectionLife || connectionLife.signal.aborted) throw new McpTransportError('disconnected', requestId, true);
      if (typeof result.protocolVersion !== 'string' || !versions.includes(result.protocolVersion)) {
        throw new McpTransportError('unsupported_protocol', requestId, true);
      }
      if (!object(result.capabilities) || !object(result.serverInfo) || typeof result.serverInfo.name !== 'string'
        || typeof result.serverInfo.version !== 'string') throw new McpTransportError('protocol_error', requestId, true);
      this.#version = result.protocolVersion;
      this.#hasTools = object(result.capabilities.tools);
      await this.#request('notifications/initialized', undefined, signal, true);
      if (this.#life !== connectionLife || connectionLife.signal.aborted) throw new McpTransportError('disconnected');
      this.#state = 'connected';
    } catch (error) {
      if (this.#life === connectionLife) this.close();
      throw error;
    }
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    this.#requireTools();
    const deadline = Date.now() + this.#timeoutMs;
    const tools: McpTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    for (let page = 0; page < this.#maxPages; page++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new McpTransportError('timeout');
      const { result, requestId } = await this.#request('tools/list', cursor === undefined ? {} : { cursor }, signal, false, remainingMs);
      bytes += Buffer.byteLength(JSON.stringify(result));
      if (bytes > this.#maxBytes) throw new McpTransportError('limit_exceeded', requestId, true);
      if (!Array.isArray(result.tools)) throw new McpTransportError('protocol_error', requestId, true);
      for (const raw of result.tools) {
        if (!object(raw) || !toolName(raw.name) || !object(raw.inputSchema) || raw.inputSchema.type !== 'object'
          || (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 32_768))
          || (raw.annotations !== undefined && !object(raw.annotations)) || names.has(raw.name)) {
          throw new McpTransportError('protocol_error', requestId, true);
        }
        names.add(raw.name);
        tools.push({ name: raw.name, inputSchema: raw.inputSchema,
          ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
          ...(object(raw.annotations) && typeof raw.annotations.readOnlyHint === 'boolean' ? { readOnlyHint: raw.annotations.readOnlyHint } : {}),
        });
        if (tools.length > this.#maxTools) throw new McpTransportError('limit_exceeded', requestId, true);
      }
      if (result.nextCursor === undefined) return tools;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 4096 || cursors.has(result.nextCursor)) {
        throw new McpTransportError('protocol_error', requestId, true);
      }
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    throw new McpTransportError('limit_exceeded');
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    this.#requireTools();
    if (!toolName(name) || !object(args)) throw new McpTransportError('invalid_config');
    const { result, requestId } = await this.#request('tools/call', { name, arguments: args }, signal);
    if (!Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== 'boolean')) {
      throw new McpTransportError('protocol_error', requestId, true);
    }
    return { isError: result.isError === true, content: result.content, requestId,
      ...(own(result, 'structuredContent') ? { structuredContent: result.structuredContent } : {}) };
  }

  close(): void {
    this.#shutdown('disconnected');
  }

  #requireTools(): void {
    if (this.#state !== 'connected') throw new McpTransportError('not_connected');
    if (!this.#hasTools) throw new McpTransportError('unsupported_capability');
  }

  #shutdown(code: McpTransportErrorCode, unexpected = false): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#life.abort(new McpTransportError(code));
    const child = this.#child;
    this.#child = undefined;
    if (child) {
      child.stdin.end();
      const terminate = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }, 200);
      const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1200);
      terminate.unref(); kill.unref();
      child.once('exit', () => { clearTimeout(terminate); clearTimeout(kill); });
    }
    if (this.#config.kind === 'http' && this.#session) {
      const headers: Record<string, string> = { 'Mcp-Session-Id': this.#session };
      if (this.#version) headers['MCP-Protocol-Version'] = this.#version;
      void fetch(this.#config.url, { method: 'DELETE', headers, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(1000) })
        .then(response => response.body?.cancel()).catch(() => {});
    }
    this.#session = undefined;
    if (unexpected) {
      // 모든 전송 핸들을 정리한 뒤 알린다. 콜백의 close()는 이미 종료된 상태라 재진입하지 않는다.
      try { this.#onDisconnected?.(new McpTransportError(code)); } catch { /* 상태 알림 실패가 전송 종료를 되돌릴 수 없다. */ }
    }
  }

  #startChild(): void {
    if (this.#config.kind !== 'stdio') return;
    const child = spawn(this.#config.command, this.#config.args, {
      shell: false, windowsHide: true, env: minimalEnvironment(), stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.#child = child;
    const fail = (): void => { if (this.#child === child) this.#shutdown('disconnected', true); };
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stdout.on('end', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.#child !== child) return;
      try { this.#receiveStdio(chunk); } catch (error) {
        this.#shutdown(error instanceof McpTransportError ? error.code : 'protocol_error', true);
      }
    });
  }

  #receiveStdio(chunk: Buffer): void {
    if (this.#pending.size === 0) {
      this.#idleBytes += chunk.length;
      if (this.#idleBytes > this.#maxBytes) throw new McpTransportError('limit_exceeded');
    }
    for (const context of this.#pending.values()) {
      context.bytes += chunk.length;
      if (context.bytes > this.#maxBytes) throw new McpTransportError('limit_exceeded');
    }
    this.#stdout = Buffer.concat([this.#stdout, chunk]);
    let newline: number;
    while ((newline = this.#stdout.indexOf(10)) !== -1) {
      const line = this.#stdout.subarray(0, newline);
      this.#stdout = this.#stdout.subarray(newline + 1);
      if (line.length > this.#maxBytes) throw new McpTransportError('limit_exceeded');
      const message = this.#parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      if (typeof message.method === 'string') {
        if (own(message, 'id')) this.#writeStdio(this.#serverReply(message));
      } else {
        const id = message.id;
        if (typeof id !== 'string') throw new McpTransportError('protocol_error');
        const context = this.#pending.get(id);
        if (!context) {
          if (this.#retired.has(id)) continue;
          throw new McpTransportError('protocol_error');
        }
        context.resolve?.(message);
      }
    }
    if (this.#stdout.length > this.#maxBytes) throw new McpTransportError('limit_exceeded');
  }

  #parse(text: string): JsonObject {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new McpTransportError('protocol_error'); }
    if (!object(value) || value.jsonrpc !== '2.0') throw new McpTransportError('protocol_error');
    if (own(value, 'method')) {
      if (typeof value.method !== 'string' || !value.method || value.method.length > 256 || own(value, 'result') || own(value, 'error')
        || (own(value, 'params') && !object(value.params))
        || (own(value, 'id') && typeof value.id !== 'string' && !Number.isSafeInteger(value.id))) throw new McpTransportError('protocol_error');
    } else if (!own(value, 'id') || own(value, 'result') === own(value, 'error')
      || (own(value, 'error') && (!object(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== 'string'))) {
      throw new McpTransportError('protocol_error');
    }
    return value;
  }

  #serverReply(message: JsonObject): JsonObject {
    // ping 외의 서버 요청은 지원하지 않는다. 파일·모델·계정 권한을 위임하지 않는다.
    return message.method === 'ping'
      ? { jsonrpc: '2.0', id: message.id, result: {} }
      : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } };
  }

  #writeStdio(message: JsonObject): void {
    if (!this.#child || this.#child.stdin.destroyed) throw new McpTransportError('disconnected');
    const encoded = JSON.stringify(message) + '\n';
    if (this.#child.stdin.writableLength + Buffer.byteLength(encoded) > this.#maxBytes) throw new McpTransportError('limit_exceeded');
    this.#child.stdin.write(encoded);
  }

  async #request(method: string, params?: JsonObject, signal?: AbortSignal, notification = false, timeoutMs = this.#timeoutMs): Promise<{ result: JsonObject; requestId: string }> {
    if (signal?.aborted) throw new McpTransportError('aborted');
    if (this.#state !== 'connecting' && this.#state !== 'connected') throw new McpTransportError('not_connected');
    if (this.#pending.size >= 16) throw new McpTransportError('limit_exceeded');
    const context: RequestContext = { id: randomUUID(), sent: false, bytes: 0, controller: new AbortController() };
    const message: JsonObject = { jsonrpc: '2.0', ...(notification ? {} : { id: context.id }), method, ...(params === undefined ? {} : { params }) };
    let encoded: string;
    try { encoded = JSON.stringify(message); } catch { throw new McpTransportError('invalid_config', context.id); }
    if (Buffer.byteLength(encoded) > this.#maxBytes) throw new McpTransportError('limit_exceeded', context.id);
    const abort = (code: McpTransportErrorCode): void => context.controller.abort(new McpTransportError(code, context.id, context.sent));
    const life = this.#life.signal;
    const onUserAbort = (): void => abort('aborted');
    const onClose = (): void => abort(life.reason instanceof McpTransportError ? life.reason.code : 'disconnected');
    signal?.addEventListener('abort', onUserAbort, { once: true });
    life.addEventListener('abort', onClose, { once: true });
    const timer = setTimeout(() => abort('timeout'), timeoutMs);
    this.#pending.set(context.id, context);
    this.#idleBytes = 0;
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = (): void => reject(context.controller.signal.reason);
        context.controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const work = this.#config.kind === 'stdio' ? new Promise<JsonObject>((resolve, reject) => {
        context.resolve = resolve;
        context.sent = true;
        try { this.#writeStdio(message); if (notification) resolve({ jsonrpc: '2.0', id: context.id, result: {} }); }
        catch (error) { reject(error); }
      }) : this.#post(message, context, notification);
      const response = await Promise.race([work, cancelled]);
      if (own(response, 'error')) {
        const code = object(response.error) && response.error.code === -32022 ? 'unsupported_protocol' : 'rpc_error';
        throw new McpTransportError(code, context.id, context.sent);
      }
      if (!object(response.result)) throw new McpTransportError('protocol_error', context.id, context.sent);
      return { result: response.result, requestId: context.id };
    } catch (error) {
      const code = context.controller.signal.aborted && context.controller.signal.reason instanceof McpTransportError
        ? context.controller.signal.reason.code : error instanceof McpTransportError ? error.code : 'disconnected';
      if ((code === 'aborted' || code === 'timeout') && context.sent && !notification && method !== 'initialize' && !life.aborted) {
        this.#cancelRequest(context.id, life);
      }
      if (['disconnected', 'protocol_error', 'auth_required', 'session_expired', 'unsupported_protocol'].includes(code)
        && this.#life.signal === life && !life.aborted) this.#shutdown(code, true);
      throw new McpTransportError(code, context.id, context.sent);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onUserAbort);
      life.removeEventListener('abort', onClose);
      if (onAbort) context.controller.signal.removeEventListener('abort', onAbort);
      this.#pending.delete(context.id);
      this.#retired.add(context.id);
      if (this.#retired.size > 256) this.#retired.delete(this.#retired.values().next().value!);
    }
  }

  #cancelRequest(requestId: string, life: AbortSignal): void {
    const message = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } };
    if (this.#config.kind === 'stdio') {
      try { this.#writeStdio(message); } catch { /* 취소 통지는 최선 노력이며 실행 취소 증거가 아니다. */ }
      return;
    }
    const headers: Record<string, string> = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    if (this.#session) headers['Mcp-Session-Id'] = this.#session;
    if (this.#version) headers['MCP-Protocol-Version'] = this.#version;
    void fetch(this.#config.url, { method: 'POST', headers, body: JSON.stringify(message), redirect: 'manual', credentials: 'omit',
      signal: AbortSignal.any([life, AbortSignal.timeout(1000)]) })
      .then(response => response.body?.cancel()).catch(() => {});
  }

  async #post(message: JsonObject, context: RequestContext, notification = false): Promise<JsonObject> {
    if (this.#config.kind !== 'http') throw new McpTransportError('invalid_config');
    context.controller.signal.throwIfAborted();
    const headers: Record<string, string> = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    if (this.#version) headers['MCP-Protocol-Version'] = this.#version;
    if (this.#session) headers['Mcp-Session-Id'] = this.#session;
    context.sent = true;
    const response = await fetch(this.#config.url, {
      method: 'POST', headers, body: JSON.stringify(message), redirect: 'manual', credentials: 'omit', signal: context.controller.signal,
    });
    try {
      context.controller.signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) throw new McpTransportError('auth_required');
      if (response.status === 404 && this.#session) {
        this.#shutdown('session_expired', true);
        throw new McpTransportError('session_expired');
      }
      if (response.status !== (notification ? 202 : 200)) throw new McpTransportError('http_error');
      const session = response.headers.get('mcp-session-id');
      if (session !== null) {
        if (!/^[\x21-\x7e]{1,512}$/.test(session) || (message.method !== 'initialize' && session !== this.#session)) {
          throw new McpTransportError('protocol_error');
        }
        if (message.method === 'initialize') this.#session = session;
      }
      if (notification) return { jsonrpc: '2.0', id: context.id, result: {} };
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json' && contentType !== 'text/event-stream') throw new McpTransportError('protocol_error');
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) > this.#maxBytes) throw new McpTransportError('limit_exceeded');
      if (!response.body) throw new McpTransportError('protocol_error');
      return await this.#readBody(response.body, contentType === 'text/event-stream', context);
    } finally {
      if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }

  async #readBody(body: ReadableStream<Uint8Array>, sse: boolean, context: RequestContext): Promise<JsonObject> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const decode = (value?: Uint8Array, stream = false): string => {
      try { return decoder.decode(value, { stream }); } catch { throw new McpTransportError('protocol_error'); }
    };
    let buffer = '';
    let data: string[] = [];
    let event = '';
    const processLine = async (line: string): Promise<JsonObject | undefined> => {
      if (!line) {
        const raw = data.join('\n');
        const kind = event;
        data = []; event = '';
        if (!raw) return;
        if (kind && kind !== 'message') throw new McpTransportError('protocol_error');
        const message = this.#parse(raw);
        if (typeof message.method === 'string') {
          if (own(message, 'id')) await this.#post(this.#serverReply(message), context, true);
          return;
        }
        if (message.id !== context.id) throw new McpTransportError('protocol_error');
        return message;
      }
      if (line.startsWith(':')) return;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      // id/retry는 자동 재연결·재전송을 시작하지 않는다.
      return;
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          context.bytes += value.byteLength;
          if (context.bytes > this.#maxBytes) throw new McpTransportError('limit_exceeded');
          buffer += decode(value, true);
        }
        if (done) buffer += decode();
        if (sse) {
          while (true) {
            const newline = buffer.search(/[\r\n]/);
            if (newline === -1 || (!done && buffer[newline] === '\r' && newline === buffer.length - 1)) break;
            const line = buffer.slice(0, newline);
            const width = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1;
            buffer = buffer.slice(newline + width);
            const result = await processLine(line);
            if (result) return result;
          }
          if (done) throw new McpTransportError('protocol_error');
        } else if (done) {
          const message = this.#parse(buffer);
          if (own(message, 'method') || message.id !== context.id) throw new McpTransportError('protocol_error');
          return message;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
