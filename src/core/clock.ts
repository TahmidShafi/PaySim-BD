export interface Clock {
  nowMs(): number;
  nowIso(): string;
  advanceMs(deltaMs: number): void;
}

export class VirtualClock implements Clock {
  private currentMs: number;

  constructor(initialMs: number = Date.now()) {
    this.currentMs = initialMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  advanceMs(deltaMs: number): void {
    if (deltaMs < 0) {
      throw new Error(`Cannot advance clock backwards: ${deltaMs}ms`);
    }
    this.currentMs += deltaMs;
  }

  setMs(timestampMs: number): void {
    this.currentMs = timestampMs;
  }
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  advanceMs(_deltaMs: number): void {
    throw new Error('SystemClock cannot be manually advanced. Use VirtualClock for simulation.');
  }
}
