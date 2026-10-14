import { describe, it, expect } from 'vitest';
import { VirtualClock, SystemClock } from '../../src/core/clock.js';

describe('Clock System', () => {
  describe('VirtualClock', () => {
    it('initializes with a specified timestamp', () => {
      const fixedMs = 1700000000000;
      const clock = new VirtualClock(fixedMs);
      expect(clock.nowMs()).toBe(fixedMs);
      expect(clock.nowIso()).toBe(new Date(fixedMs).toISOString());
    });

    it('advances time forward correctly', () => {
      const startMs = 1700000000000;
      const clock = new VirtualClock(startMs);

      clock.advanceMs(1000); // +1 second
      expect(clock.nowMs()).toBe(startMs + 1000);

      clock.advanceMs(3600000); // +1 hour
      expect(clock.nowMs()).toBe(startMs + 3601000);
    });

    it('rejects negative advancement', () => {
      const clock = new VirtualClock(1700000000000);
      expect(() => clock.advanceMs(-500)).toThrow(/Cannot advance clock backwards/);
    });

    it('supports setting absolute time', () => {
      const clock = new VirtualClock(1000);
      clock.setMs(5000);
      expect(clock.nowMs()).toBe(5000);
      expect(clock.nowIso()).toBe(new Date(5000).toISOString());
    });
  });

  describe('SystemClock', () => {
    it('returns current time', () => {
      const clock = new SystemClock();
      const before = Date.now();
      const now = clock.nowMs();
      const after = Date.now();

      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(after);
      expect(typeof clock.nowIso()).toBe('string');
    });

    it('throws when attempting to advance SystemClock', () => {
      const clock = new SystemClock();
      expect(() => clock.advanceMs(1000)).toThrow(/SystemClock cannot be manually advanced/);
    });
  });
});
