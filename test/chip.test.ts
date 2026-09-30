import { describe, expect, it } from 'vitest';
import { CPU_HZ, renderWrites, type RegisterWrite } from '../src/index.js';

/**
 * The register interface on its own: writes in, samples out, no notes anywhere.
 *
 * `notes.test.ts` covers the chip through the note adapter; these talk to it the
 * way a driver does, so a change to the adapter cannot hide a change here.
 */

const RATE = 44100;
const at = (time: number, address: number, value: number): RegisterWrite => ({
  time,
  address,
  value,
});
const render = (writes: RegisterWrite[], seconds: number) =>
  renderWrites(writes, seconds, { sampleRate: RATE, oversample: 1, filters: false, tail: 0 });

/** Rising crossings of the midpoint, over a slice in seconds. */
function measureHz(samples: Float32Array, from: number, to: number): number {
  const slice = samples.subarray(Math.round(from * RATE), Math.round(to * RATE));
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of slice) {
    lo = Math.min(lo, value);
    hi = Math.max(hi, value);
  }
  const mid = (lo + hi) / 2;
  let crossings = 0;
  let first = -1;
  let last = -1;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1] <= mid && slice[i] > mid) {
      crossings++;
      if (first < 0) first = i;
      last = i;
    }
  }
  return crossings < 2 ? 0 : ((crossings - 1) * RATE) / (last - first);
}

const peakIn = (samples: Float32Array, from: number, to: number) => {
  let peak = 0;
  for (let i = Math.round(from * RATE); i < Math.min(samples.length, Math.round(to * RATE)); i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  return peak;
};

/** Pulse 1 at a steady level and period: the minimum a driver writes for a note. */
const pulseNote = (period: number, control = 0xbf, sweep = 0x08) => [
  at(0, 0x4015, 0x01),
  at(0, 0x4000, control),
  at(0, 0x4001, sweep),
  at(0, 0x4002, period & 0xff),
  at(0, 0x4003, period >> 8),
];

describe('the pulse channel, through its registers', () => {
  it('sounds at CPU / (16 × (period + 1))', () => {
    const { samples } = render(pulseNote(253), 0.5);
    const expected = CPU_HZ / (16 * 254);
    expect(measureHz(samples, 0.05, 0.45)).toBeCloseTo(expected, 0);
  });

  it('is silenced at once by clearing its bit in $4015', () => {
    const { samples } = render([...pulseNote(253), at(0.25, 0x4015, 0x00)], 0.5);
    expect(peakIn(samples, 0, 0.24)).toBeGreaterThan(0);
    expect(peakIn(samples, 0.251, 0.5)).toBe(0);
  });

  it('runs out when the length counter is not halted', () => {
    // $9F: duty 2, counter running, constant volume 15. Index 5 in $4003's top
    // bits loads 4 half-frames — about 33 ms.
    const writes = pulseNote(253, 0x9f);
    writes[4] = at(0, 0x4003, 5 << 3);
    const { samples } = render(writes, 0.5);
    expect(peakIn(samples, 0, 0.02)).toBeGreaterThan(0);
    expect(peakIn(samples, 0.05, 0.5)).toBe(0);
  });

  it('is muted by the sweep unit at its power-on value, for periods from $400 up', () => {
    // $4001 = 0 is shift 0, add: the target is twice the period, past $7FF from
    // $400 up, and the channel mutes though nothing is sweeping. $08 (negate)
    // is what drivers write to keep low notes audible.
    expect(render(pulseNote(0x500, 0xbf, 0x00), 0.2).peak).toBe(0);
    expect(render(pulseNote(0x500, 0xbf, 0x08), 0.2).peak).toBeGreaterThan(0);
  });
});

describe('the triangle channel, through its registers', () => {
  const triangle = (period: number) => [
    at(0, 0x4015, 0x04),
    at(0, 0x4008, 0xff),
    at(0, 0x400a, period & 0xff),
    at(0, 0x400b, period >> 8),
  ];

  it('sounds an octave below a pulse at the same period', () => {
    const { samples } = render(triangle(253), 0.5);
    expect(measureHz(samples, 0.05, 0.45)).toBeCloseTo(CPU_HZ / (32 * 254), 0);
  });

  it('holds its last step when stopped, rather than dropping to zero', () => {
    const { samples } = render([...triangle(253), at(0.2, 0x4015, 0x00)], 0.4);
    const held = samples.subarray(Math.round(0.21 * RATE));
    // Flat: the sequencer stopped where it was. Not necessarily zero.
    expect(Math.max(...held) - Math.min(...held)).toBe(0);
  });
});

describe('the noise channel, through its registers', () => {
  const noise = (mode: number) => [
    at(0, 0x4015, 0x08),
    at(0, 0x400c, 0x3f),
    at(0, 0x400e, mode | 0x08),
    at(0, 0x400f, 0x00),
  ];

  it('makes sound, and a different one in short mode', () => {
    const long = render(noise(0x00), 0.3).samples;
    const short = render(noise(0x80), 0.3).samples;
    expect(peakIn(long, 0, 0.3)).toBeGreaterThan(0);
    let same = true;
    for (let i = 0; i < long.length; i++) if (long[i] !== short[i]) same = false;
    expect(same).toBe(false);
  });

  it('decays on its own envelope when constant volume is off', () => {
    // $00: envelope on, period 0 — 15 steps at 240 Hz, silent by ~70 ms.
    const writes = noise(0);
    writes[1] = at(0, 0x400c, 0x00);
    const { samples } = render(writes, 0.3);
    expect(peakIn(samples, 0, 0.04)).toBeGreaterThan(0);
    expect(peakIn(samples, 0.1, 0.3)).toBe(0);
  });
});

describe('writes', () => {
  it('ignores addresses outside the APU, and the DMC registers it does not model', () => {
    const quiet = render([at(0, 0x2000, 0xff), at(0, 0x4010, 0xff), at(0, 0x4011, 0x7f)], 0.1);
    expect(quiet.peak).toBe(0);
  });

  it('applies writes at the same moment in the order given', () => {
    // Enable first, then load the counter: sound. The other way round, the load
    // is ignored because the channel was off — silence.
    const good = render(pulseNote(253, 0x9f), 0.1);
    const late = [...pulseNote(253, 0x9f).slice(1), at(0, 0x4015, 0x01)];
    expect(good.peak).toBeGreaterThan(0);
    expect(render(late, 0.1).peak).toBe(0);
  });
});

describe('speed-ups that must not change a sample', () => {
  it('fills the same levels in blocks as one sample at a time', async () => {
    const { Apu } = await import('../src/index.js');
    const program = (chip: InstanceType<typeof Apu>) => {
      chip.write(0x4015, 0x0f);
      chip.write(0x4000, 0x9f);
      chip.write(0x4001, 0x8b);
      chip.write(0x4002, 0x90);
      chip.write(0x4003, 0x09);
      chip.write(0x4008, 0x7f);
      chip.write(0x400a, 0x40);
      chip.write(0x400b, 0x21);
      chip.write(0x400c, 0x04);
      chip.write(0x400e, 0x03);
      chip.write(0x400f, 0x18);
    };
    const n = 40000;
    const a = new Apu(44100);
    const b = new Apu(44100);
    program(a);
    program(b);
    const one = { p1: [] as number[], p2: [] as number[], t: [] as number[], n: [] as number[] };
    for (let i = 0; i < n; i++) {
      const [x, y, z, w] = a.levels();
      one.p1.push(x);
      one.p2.push(y);
      one.t.push(z);
      one.n.push(w);
    }
    const p1 = new Uint8Array(n);
    const p2 = new Uint8Array(n);
    const t = new Uint8Array(n);
    const noise = new Float64Array(n);
    // Uneven blocks, so the cuts land everywhere relative to the frame counter.
    for (let done = 0, size = 1; done < n; done += size, size = (size * 7) % 997 || 1) {
      b.render(Math.min(size, n - done), p1, p2, t, noise, done);
    }
    expect(Array.from(p1)).toEqual(one.p1);
    expect(Array.from(p2)).toEqual(one.p2);
    expect(Array.from(t)).toEqual(one.t);
    expect(Array.from(noise)).toEqual(one.n);
  });

  it('holds the whole shift-register cycle in its table', async () => {
    const { LONG_CYCLE, LONG_STATES, LONG_INDEX, LONG_HIGH_BEFORE } = await import('../src/lfsr.js');
    let state = 1;
    let high = 0;
    for (let i = 0; i < LONG_CYCLE; i++) {
      expect(LONG_STATES[i]).toBe(state);
      expect(LONG_INDEX[state]).toBe(i);
      expect(LONG_HIGH_BEFORE[i]).toBe(high);
      if ((state & 1) === 0) high++;
      const feedback = (state & 1) ^ ((state >> 1) & 1);
      state = (state >> 1) | (feedback << 14);
    }
    // One cycle through every non-zero state and back to the start.
    expect(state).toBe(1);
    expect(LONG_HIGH_BEFORE[LONG_CYCLE]).toBe(high);
  });
});
