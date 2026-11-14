/**
 * Time sources. Behaviour runs on wall-clock time; speech/lip-sync runs on the audio clock so mouth
 * shapes stay locked to what is actually heard. In capture mode both are replaced by one virtual
 * clock that advances a fixed step per rendered frame (deterministic offline rendering).
 */
export interface Clock {
  now(): number; // seconds
}

export class WallClock implements Clock {
  now() {
    return performance.now() / 1000;
  }
}

export class AudioClock implements Clock {
  constructor(private ctx: BaseAudioContext) {}
  now() {
    return this.ctx.currentTime;
  }
}

export class VirtualClock implements Clock {
  private t = 0;
  now() {
    return this.t;
  }
  advance(dt: number) {
    this.t += dt;
  }
}
