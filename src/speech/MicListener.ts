/**
 * Microphone voice-activity detector. While the user talks the avatar switches to attentive
 * listening (eye contact, small nods); a pause triggers an acknowledgement nod. Optional barge-in:
 * user speech interrupts the avatar. Browser echo cancellation keeps the avatar's own voice out.
 */
export class MicListener {
  onSpeechStart: () => void = () => {};
  onSpeechEnd: () => void = () => {};
  level = 0;
  userSpeaking = false;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private buf = new Float32Array(1024);
  private above = 0;
  private below = 0;
  private noise = 0.01;

  constructor(private ctx: AudioContext) {}

  get enabled() {
    return !!this.stream;
  }

  async start() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.stream = null;
    this.analyser = null;
    this.source = null;
    if (this.userSpeaking) {
      this.userSpeaking = false;
      this.onSpeechEnd();
    }
  }

  update(dt: number) {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (const x of this.buf) s += x * x;
    const rms = Math.sqrt(s / this.buf.length);
    this.level = rms;
    // adaptive noise floor (slowly follows the quietest level)
    this.noise = rms < this.noise ? this.noise * 0.9 + rms * 0.1 : this.noise * 0.999 + rms * 0.001;
    const on = rms > Math.max(0.012, this.noise * 3.5);
    this.above = on ? this.above + dt : 0;
    this.below = on ? 0 : this.below + dt;
    if (!this.userSpeaking && this.above > 0.15) {
      this.userSpeaking = true;
      this.onSpeechStart();
    } else if (this.userSpeaking && this.below > 0.7) {
      this.userSpeaking = false;
      this.onSpeechEnd();
    }
  }
}
