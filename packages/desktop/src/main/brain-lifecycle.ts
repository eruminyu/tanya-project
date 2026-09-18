import type {CommandResult} from '../shared/bridge.js';
import type {RuntimeState} from '../shared/runtime.js';
import {validateConnection, type BrainConnection} from './brain-connection.js';
import type {DesktopRuntime} from './runtime/desktop-runtime.js';

type Brain = Pick<BrainConnection, 'connect' | 'reconnect' | 'disconnect'>;
type Runtime = Pick<DesktopRuntime, 'snapshot' | 'start' | 'stop'>;
type Guard = () => void;

/** 연결 대상의 소유권과 사용자 명령 잠금은 main에서 한 곳이 관리한다. */
export class BrainLifecycle {
  private target: 'embedded' | 'external' = 'external';
  private busy = false;
  private closing = false;
  private shutdownPending: Promise<RuntimeState> | null = null;

  constructor(private readonly brain: Brain, private readonly runtime: Runtime) {}

  private occupied(): boolean {
    return this.closing || this.busy || this.runtime.snapshot().busy;
  }

  private check(guard: Guard): void {
    if (this.closing) throw Error('request_cancelled');
    guard();
  }

  private async command(operation: () => Promise<CommandResult>, guard: Guard): Promise<CommandResult> {
    if (this.closing) return {ok: false, code: 'brain_unavailable'};
    if (this.occupied()) return {ok: false, code: 'busy'};
    this.busy = true;
    try {
      this.check(guard);
      const result = await operation();
      this.check(guard);
      return result;
    } catch {
      this.brain.disconnect();
      return {ok: false, code: 'brain_unavailable'};
    } finally {
      this.busy = false;
    }
  }

  async runtimeCommand(operation: () => Promise<RuntimeState>): Promise<RuntimeState> {
    if (this.occupied()) return {...this.runtime.snapshot(), reason: 'runtime_busy'};
    this.busy = true;
    try { return await operation(); }
    finally {
      // ready/error는 내장 시작에 도달한 상태다. 검증 실패/대화상자 취소로
      // stopped에 머문 외부 연결은 유지하고, 시작 실패 후에도 내장을 재시도한다.
      const phase = this.runtime.snapshot().phase;
      if (phase === 'ready' || phase === 'error') this.target = 'embedded';
      this.busy = false;
    }
  }

  start(guard: Guard = () => {}): Promise<RuntimeState> {
    return this.runtimeCommand(() => {
      this.check(guard);
      // 처음 시작이 실패해 주소가 없어도 명시 재시도의 대상은 내장 Brain이다.
      if (this.runtime.snapshot().available) this.target = 'embedded';
      return this.runtime.start(() => this.check(guard));
    });
  }

  connectExternal(options: unknown, guard: Guard = () => {}): Promise<CommandResult> {
    return this.command(async () => {
      try { validateConnection(options); }
      catch { return this.brain.connect(options); }
      await this.runtime.stop();
      this.check(guard);
      this.target = 'external';
      return this.brain.connect(options);
    }, guard);
  }

  disconnect(): Promise<CommandResult> {
    return this.command(async () => {
      // stop은 소유 프로세스와 연결만 종료하며 마지막 연결 대상은 유지한다.
      await this.runtime.stop();
      return {ok: true};
    }, () => {});
  }

  reconnect(guard: Guard = () => {}): Promise<CommandResult> {
    return this.command(async () => {
      if (this.target === 'embedded' && this.runtime.snapshot().phase !== 'ready') {
        const state = await this.runtime.start(() => this.check(guard));
        return state.phase === 'ready' && state.reason === null
          ? {ok: true} : {ok: false, code: 'connection_failed'};
      }
      return this.brain.reconnect();
    }, guard);
  }

  shutdown(): Promise<RuntimeState> {
    this.closing = true;
    this.shutdownPending ??= this.runtime.stop();
    return this.shutdownPending;
  }
}
