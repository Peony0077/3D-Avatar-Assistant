declare module "@met4citizen/headaudio/dist/headaudio.min.mjs" {
  export class HeadAudio extends AudioWorkletNode {
    constructor(ctx: BaseAudioContext, options?: { processorOptions?: Record<string, unknown>; parameterData?: Record<string, number> });
    loadModel(url: string, reset?: boolean): Promise<void>;
    update(dtMs: number): void;
    start(): void;
    stop(): void;
    calibrate(): void;
    onvalue: ((key: string, value: number) => void) | null;
    onstarted: ((data: unknown) => void) | null;
    onended: ((data: unknown) => void) | null;
  }
}
