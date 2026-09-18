import type { DesktopBridge } from '../../shared/bridge.js';
export type MicrophoneState = 'idle' | 'requesting' | 'recording' | 'transcribing';
/** Opt-in push-to-talk. No browser speech service or background recording is used. */
export class MicrophoneCapture {
  private generation = 0;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: MicrophoneState = 'idle';
  constructor(private readonly bridge: Pick<DesktopBridge, 'armMicrophone' | 'transcribeAudio' | 'cancelTranscription'>,
    private readonly onState: (state: MicrophoneState) => void,
    private readonly onText: (text: string) => Promise<void>,
    private readonly onError: (message: string) => void) {}
  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    const generation = ++this.generation;
    this.change('requesting');
    try {
      if (!(await this.bridge.armMicrophone()).ok) throw new Error('unavailable');
      if (generation !== this.generation) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      if (!MediaRecorder.isTypeSupported('audio/webm')) throw new Error('format');
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      this.recorder = recorder;
      const chunks: Blob[] = []; let bytes = 0;
      recorder.ondataavailable = event => {
        if (generation !== this.generation || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > 4 * 1024 * 1024) { this.cancel(); this.onError('녹음 길이 제한에 도달했어요. 짧게 다시 말해 주세요.'); return; }
        chunks.push(event.data);
      };
      recorder.onerror = () => { if (generation === this.generation) { this.cancel(); this.onError('마이크 녹음을 완료하지 못했어요.'); } };
      recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        if (generation !== this.generation) return;
        this.stream = null; this.recorder = null; this.clearTimer(); this.change('transcribing');
        try {
          const data = new Uint8Array(await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer());
          if (generation !== this.generation) return;
          const result = await this.bridge.transcribeAudio({ data, contentType: 'audio/webm' });
          if (generation !== this.generation) return;
          this.change('idle');
          if (result.ok) await this.onText(result.text);
          else if (result.code !== 'cancelled') this.onError('말씀을 인식하지 못했어요. 다시 말하거나 글로 입력해 주세요.');
        } catch { if (generation === this.generation) this.onError('음성 인식 서비스에 연결하지 못했어요.'); }
        finally { if (generation === this.generation) this.change('idle'); }
      };
      recorder.start(250); this.change('recording'); this.timer = setTimeout(() => this.finish(), 30000);
    } catch {
      if (generation === this.generation) { this.cancel(); this.onError('마이크를 사용할 수 없어요. Windows의 마이크 권한을 확인해 주세요.'); }
    }
  }
  finish(): void {
    if (this.state === 'recording' && this.recorder?.state === 'recording') { this.clearTimer(); this.recorder.stop(); }
  }
  cancel(): void {
    ++this.generation; this.clearTimer();
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null; this.recorder = null;
    void this.bridge.cancelTranscription().catch(() => {}); this.change('idle');
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private change(state: MicrophoneState): void { this.state = state; this.onState(state); }
}
