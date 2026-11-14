import { HeadAudio } from "@met4citizen/headaudio/dist/headaudio.min.mjs";
import workletUrl from "@met4citizen/headaudio/dist/headworklet.min.mjs?url";
import modelUrl from "@met4citizen/headaudio/dist/model-en-mixed.bin?url";
import { type VisemeWeights, emptyWeights } from "./LipSyncTrack";
import type { Viseme } from "./visemes";

/**
 * Audio-driven lip sync for audio that has no phoneme timings (recorded voice, another TTS,
 * a speech-to-speech model). Uses HeadAudio (MIT): MFCC features + Gaussian viseme prototypes,
 * fully in-browser. Less precise than the text-timed path, so it is the fallback.
 */
export class AudioLipSync {
  readonly weights: VisemeWeights = emptyWeights();
  active = false;
  /** Voice activity inside the audio. */
  speaking = false;
  loud = 0;
  private node!: HeadAudio;
  private analyser!: AnalyserNode;
  private delay!: DelayNode;
  private source: AudioBufferSourceNode | null = null;
  private buf = new Float32Array(1024);

  private constructor(private ctx: AudioContext) {}

  static async create(ctx: AudioContext, destination: AudioNode): Promise<AudioLipSync> {
    const a = new AudioLipSync(ctx);
    await ctx.audioWorklet.addModule(workletUrl);
    a.node = new HeadAudio(ctx, {
      processorOptions: {},
      parameterData: { vadMode: 1, vadGateActiveDb: -42, vadGateInactiveDb: -55, silMode: 0, speakerMeanHz: 210 },
    });
    await a.node.loadModel(modelUrl);
    a.node.onvalue = (key, value) => {
      a.weights[key.replace("viseme_", "") as Viseme] = value;
    };
    a.node.onstarted = () => (a.speaking = true);
    a.node.onended = () => (a.speaking = false);
    a.analyser = ctx.createAnalyser();
    a.analyser.fftSize = 1024;
    // HeadAudio needs ~50-100 ms to classify; delay what the listener hears by the same amount.
    a.delay = ctx.createDelay(0.5);
    a.delay.delayTime.value = 0.09;
    a.delay.connect(destination);
    return a;
  }

  /** Play an audio file (any format the browser decodes) and lip-sync it. */
  async play(data: ArrayBuffer): Promise<void> {
    this.stop();
    const audio = await this.ctx.decodeAudioData(data);
    const src = this.ctx.createBufferSource();
    src.buffer = audio;
    src.connect(this.node);
    src.connect(this.analyser);
    src.connect(this.delay);
    this.node.start();
    this.source = src;
    this.active = true;
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start();
    });
    if (this.source === src) this.stop();
  }

  stop() {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* not started */
      }
      this.source.disconnect();
      this.source = null;
    }
    this.node?.stop();
    this.active = false;
    this.speaking = false;
    for (const k of Object.keys(this.weights) as Viseme[]) this.weights[k] = 0;
  }

  update(dtMs: number) {
    if (!this.node) return;
    this.node.update(dtMs);
    if (this.active) {
      this.analyser.getFloatTimeDomainData(this.buf);
      let s = 0;
      for (const x of this.buf) s += x * x;
      this.loud = Math.min(1.5, Math.sqrt(s / this.buf.length) * 8);
    } else {
      this.loud = 0;
    }
  }
}
