import type { AudioEvent, DesktopBridge } from '../../shared/bridge.js';
import { createPlaybackManager } from '../../vendor/airi-audio/playback-manager.js';
import type { PlaybackItem } from '../../vendor/airi-audio/types.js';
import { calculateLipSyncLevel, smoothLipSyncLevel } from '../../../../client/src/lip-sync';

type Packet = Extract<AudioEvent, { kind: 'audio' }>;
/** Actual Web Audio playback stays in the renderer; lifecycle acknowledgements go through fixed IPC. */
export class SpeechPlayer {
  private context: AudioContext | null = null;
  private generation = 0;
  private sequence = 0;
  private queuedBytes = 0;
  private delivery = Promise.resolve();
  private disposed = false;
  private readonly manager;
  constructor(
    private readonly bridge: Pick<DesktopBridge, 'reportPlayback'>,
    private readonly onLevel: (level: number, speaking: boolean) => void,
    private readonly onError: () => void,
    private readonly createContext: () => AudioContext = () => new AudioContext()
  ) {
    this.manager = createPlaybackManager<Packet>({ play: (item, signal) => this.play(item, signal), maxVoices: 1, overflowPolicy: 'queue' });
  }
  async unlock(): Promise<void> {
    if (this.disposed) return;
    this.context ??= this.createContext();
    if (this.context.state === 'suspended') await this.context.resume();
  }
  accept(event: AudioEvent): void {
    if (event.kind === 'reset') { this.reset(); return; }
    if (this.disposed) return;
    const generation = this.generation;
    this.queuedBytes += event.data.byteLength;
    let transferred = false, released = false;
    const releasePending = () => {
      if (!released && !transferred && generation === this.generation) { this.queuedBytes -= event.data.byteLength; released = true; }
    };
    this.delivery = this.delivery.then(async () => {
      if (generation !== this.generation || this.disposed) return;
      const result = await this.bridge.reportPlayback({ playbackId: event.playbackId, state: 'queued' });
      if (generation !== this.generation || this.disposed) return;
      if (!result.ok) { releasePending(); return; }
      if (event.data.byteLength > 4 * 1024 * 1024 || this.queuedBytes > 8 * 1024 * 1024) {
        releasePending();
        await this.bridge.reportPlayback({ playbackId: event.playbackId, state: 'failed' });
        if (generation === this.generation) this.onError(); return;
      }
      this.manager.schedule({ id: event.playbackId, intentId: String(generation), streamId: String(generation),
        segmentId: event.playbackId, sequence: this.sequence++, priority: 100, text: event.sentence,
        special: null, audio: event, createdAt: Date.now() });
      transferred = true;
    }).catch(() => { releasePending(); if (generation === this.generation) this.onError(); });
  }
  reset(): void {
    ++this.generation; this.manager.stopAll('reset'); this.queuedBytes = 0;
    this.delivery = Promise.resolve(); this.onLevel(0, false);
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.reset(); await this.context?.close(); this.context = null;
  }
  private async play(item: PlaybackItem<Packet>, signal: AbortSignal): Promise<void> {
    const generation = this.generation, packet = item.audio;
    let source: AudioBufferSourceNode | undefined, analyser: AnalyserNode | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let ended: (() => void) | undefined;
    const abort = () => { try { source?.stop(); } catch {} ended?.(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await this.unlock();
      if (signal.aborted || generation !== this.generation || !this.context) return;
      const bytes = new Uint8Array(packet.data).buffer;
      const decoded = await this.context.decodeAudioData(bytes);
      if (signal.aborted || generation !== this.generation) return;
      if (!decoded.length || decoded.duration > 90) throw new Error('audio_duration');
      source = this.context.createBufferSource(); analyser = this.context.createAnalyser();
      analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.55;
      source.buffer = decoded; source.connect(analyser); analyser.connect(this.context.destination);
      const finished = new Promise<void>(resolve => { ended = resolve; source!.onended = () => resolve(); });
      source.start();
      const playing = await this.bridge.reportPlayback({ playbackId: packet.playbackId, state: 'playing' });
      if (!playing.ok || signal.aborted || generation !== this.generation) { abort(); return; }
      let level = 0;
      const samples = new Uint8Array(analyser.frequencyBinCount);
      const update = () => {
        if (signal.aborted || generation !== this.generation) return;
        analyser!.getByteTimeDomainData(samples);
        level = smoothLipSyncLevel(level, calculateLipSyncLevel(samples));
        this.onLevel(level, true);
      };
      update(); timer = setInterval(update, 33);
      await finished;
      if (!signal.aborted && generation === this.generation)
        await this.bridge.reportPlayback({ playbackId: packet.playbackId, state: 'completed' });
    } catch {
      if (!signal.aborted && generation === this.generation) {
        await this.bridge.reportPlayback({ playbackId: packet.playbackId, state: 'failed' }).catch(() => {});
        if (!signal.aborted && generation === this.generation) this.onError();
      }
    } finally {
      if (timer) clearInterval(timer);
      try { source?.stop(); } catch {}
      signal.removeEventListener('abort', abort); source?.disconnect(); analyser?.disconnect();
      if (generation === this.generation) { this.queuedBytes -= packet.data.byteLength; this.onLevel(0, false); }
    }
  }
}
