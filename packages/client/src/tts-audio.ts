import type { TtsChunk } from "./brain";
import { calculateLipSyncLevel, smoothLipSyncLevel } from "./lip-sync";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
} from "./client-settings";

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** 한 문장 분량의 완성된 오디오. chunkIndex는 tts_sentence 자막 매칭에 쓴다 (T-010). */
export interface AssembledTtsAudio {
  chunkIndex: number;
  audio: Uint8Array;
}

export class TtsChunkAssembler {
  private chunkIndex: number | null = null;
  private chunks: Uint8Array[] = [];

  public append(chunk: TtsChunk): AssembledTtsAudio[] {
    const completed: AssembledTtsAudio[] = [];
    if (this.chunkIndex !== null && chunk.chunkIndex !== this.chunkIndex) {
      const assembled = this.flush();
      if (assembled) completed.push(assembled);
    }
    if (chunk.data) {
      this.chunkIndex = chunk.chunkIndex;
      this.chunks.push(decodeBase64(chunk.data));
    }
    if (chunk.isLast) {
      const assembled = this.flush();
      if (assembled) completed.push(assembled);
    }
    return completed;
  }

  public reset(): void {
    this.chunkIndex = null;
    this.chunks = [];
  }

  private flush(): AssembledTtsAudio | null {
    if (this.chunkIndex === null || this.chunks.length === 0) {
      this.chunkIndex = null;
      return null;
    }
    const assembled = { chunkIndex: this.chunkIndex, audio: concatBytes(this.chunks) };
    this.reset();
    return assembled;
  }
}

export class TtsAudioPlayer {
  private readonly assembler = new TtsChunkAssembler();
  private readonly queue: AssembledTtsAudio[] = [];
  private readonly onError: (message: string) => void;
  private readonly createAudioContext: () => AudioContext;
  private readonly onLipSync: (level: number) => void;
  private readonly onSpeakingChange?: (speaking: boolean) => void;
  private readonly onActiveSentenceChange?: (chunkIndex: number | null) => void;
  private audioContext: AudioContext | null = null;
  private activeSource: AudioBufferSourceNode | null = null;
  private finishActive: (() => void) | null = null;
  private playing = false;
  private speaking = false;
  /** 종료 신호(빈 data + isLast)를 받았는지 — 그 전에는 큐가 비어도 발화가 끝난 것이 아니다. */
  private utteranceComplete = false;
  private activeSentence: number | null = null;
  private playbackGeneration = 0;
  private analyser: AnalyserNode | null = null;
  private lipSyncTimer: ReturnType<typeof setInterval> | null = null;
  private lipSyncLevel = 0;
  private lipSyncSettings: ClientSettings;

  public constructor(
    onError: (message: string) => void = (message) => console.error(message),
    createAudioContext: () => AudioContext = () => new AudioContext(),
    onLipSync: (level: number) => void = () => undefined,
    lipSyncSettings: ClientSettings = DEFAULT_CLIENT_SETTINGS,
    onSpeakingChange?: (speaking: boolean) => void,
    onActiveSentenceChange?: (chunkIndex: number | null) => void,
  ) {
    this.onError = onError;
    this.createAudioContext = createAudioContext;
    this.onLipSync = onLipSync;
    this.lipSyncSettings = { ...lipSyncSettings };
    this.onSpeakingChange = onSpeakingChange;
    this.onActiveSentenceChange = onActiveSentenceChange;
  }

  public updateLipSyncSettings(settings: ClientSettings): void {
    this.lipSyncSettings = { ...settings };
  }

  public async unlock(): Promise<void> {
    try {
      const context = this.ensureAudioContext();
      if (context.state === "suspended") await context.resume();
    } catch (error) {
      console.error(error);
      this.onError("음성 재생을 활성화하지 못했습니다.");
    }
  }

  public append(chunk: TtsChunk): void {
    this.queue.push(...this.assembler.append(chunk));
    if (chunk.data) {
      // 새 오디오가 도착했다 — 발화 시작이며, 이전 종료 신호는 무효가 된다.
      this.utteranceComplete = false;
      this.setSpeaking(true);
    }
    if (chunk.isLast && !chunk.data) {
      // Brain의 종료 신호: 이 응답의 오디오는 더 오지 않는다.
      this.utteranceComplete = true;
      this.finishIfDrained();
    }
    void this.playNext();
  }

  public reset(): void {
    this.playbackGeneration += 1;
    this.assembler.reset();
    this.queue.length = 0;
    try {
      this.activeSource?.stop();
    } catch {
      // 이미 종료된 source는 중지할 필요가 없다.
    }
    this.finishActive?.();
    this.stopLipSync();
    this.utteranceComplete = false;
    this.setSpeaking(false);
    this.setActiveSentence(null);
  }

  private ensureAudioContext(): AudioContext {
    this.audioContext ??= this.createAudioContext();
    return this.audioContext;
  }

  private async playNext(): Promise<void> {
    if (this.playing) return;
    const item = this.queue.shift();
    if (!item) {
      this.finishIfDrained();
      return;
    }

    this.playing = true;
    const playbackGeneration = this.playbackGeneration;
    const audioBuffer = new ArrayBuffer(item.audio.byteLength);
    new Uint8Array(audioBuffer).set(item.audio);

    try {
      const context = this.ensureAudioContext();
      if (context.state === "suspended") await context.resume();
      if (playbackGeneration !== this.playbackGeneration) return;
      const decoded = await context.decodeAudioData(audioBuffer);
      if (playbackGeneration !== this.playbackGeneration) return;
      const source = context.createBufferSource();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.55;
      source.buffer = decoded;
      source.connect(analyser);
      analyser.connect(context.destination);
      this.activeSource = source;
      this.startLipSync(analyser);
      await new Promise<void>((resolve, reject) => {
        const finish = () => resolve();
        this.finishActive = finish;
        source.onended = finish;
        try {
          source.start();
          this.setSpeaking(true);
          this.setActiveSentence(item.chunkIndex);
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      console.error(error);
      this.onError("음성을 재생하지 못했습니다.");
    } finally {
      this.stopLipSync();
      this.activeSource = null;
      this.finishActive = null;
      this.playing = false;
      this.finishIfDrained();
      void this.playNext();
    }
  }

  private startLipSync(analyser: AnalyserNode): void {
    this.stopLipSync();
    this.analyser = analyser;
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const update = () => {
      analyser.getByteTimeDomainData(samples);
      const target = calculateLipSyncLevel(
        samples,
        this.lipSyncSettings.lipSyncSensitivity,
        this.lipSyncSettings.lipSyncMaxOpen,
      );
      this.lipSyncLevel = smoothLipSyncLevel(
        this.lipSyncLevel,
        target,
        this.lipSyncSettings.lipSyncSmoothing,
      );
      this.onLipSync(this.lipSyncLevel);
    };
    update();
    this.lipSyncTimer = setInterval(update, 33);
  }

  private stopLipSync(): void {
    if (this.lipSyncTimer !== null) clearInterval(this.lipSyncTimer);
    this.lipSyncTimer = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.lipSyncLevel = 0;
    this.onLipSync(0);
  }

  /** 종료 신호 이후 큐까지 소진됐을 때만 발화 종료로 판정한다 — 문장 사이 공백에서 자막이 깜빡이지 않게. */
  private finishIfDrained(): void {
    if (!this.utteranceComplete || this.playing || this.queue.length > 0) return;
    this.utteranceComplete = false;
    this.setSpeaking(false);
    this.setActiveSentence(null);
  }

  private setActiveSentence(chunkIndex: number | null): void {
    if (this.activeSentence === chunkIndex) return;
    this.activeSentence = chunkIndex;
    this.onActiveSentenceChange?.(chunkIndex);
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.onSpeakingChange?.(speaking);
  }

}
