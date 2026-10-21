import { describe, expect, it } from 'vitest';
import { Apu, EXPANSION_CHANNELS, FdsChip, N163Chip, fdsHz, n163Hz, renderNotes, renderWrites, type PitchedRow } from '../src/index.js';

/** Frequency of a buffer by its rising zero crossings, over the middle of it. */
function pitchOf(samples: Float32Array, rate: number): number {
  const from = Math.floor(samples.length * 0.25);
  const to = Math.floor(samples.length * 0.75);
  let mean = 0;
  for (let i = from; i < to; i++) mean += samples[i];
  mean /= to - from;
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if (samples[i - 1] < mean && samples[i] >= mean) crossings++;
  return crossings / ((to - from) / rate);
}

const SINE64 = Array.from({ length: 64 }, (_, i) => Math.round(31.5 + 31.5 * Math.sin((2 * Math.PI * i) / 64)));
const SQUARE32 = Array.from({ length: 32 }, (_, i) => (i < 16 ? 15 : 0));

describe('FDS', () => {
  it('plays its wave at CPU_HZ · f / 4194304', () => {
    const freq = Math.round((440 * 4194304) / 1789772.7272727273);
    const writes = [
      { time: 0, address: 0x4089, value: 0x80 },
      ...SINE64.map((v, i) => ({ time: 0, address: 0x4040 + i, value: v })),
      { time: 0, address: 0x4089, value: 0 },
      { time: 0, address: 0x4080, value: 0x80 | 32 },
      { time: 0, address: 0x4082, value: freq & 0xff },
      { time: 0, address: 0x4083, value: 0x40 | (freq >> 8) },
    ];
    const r = renderWrites(writes, 0.5);
    expect(pitchOf(r.samples, r.sampleRate)).toBeCloseTo(fdsHz(freq), -1);
    expect(r.peak).toBeGreaterThan(0.05);
  });

  it('is silent at gain 0 and while its wave is being written', () => {
    const chip = new FdsChip(48000);
    chip.write(0x4089, 0x80);
    for (let i = 0; i < 64; i++) chip.write(0x4040 + i, 63);
    chip.write(0x4080, 0x80 | 32);
    chip.write(0x4082, 0xff);
    chip.write(0x4083, 0x40);
    const out = new Float64Array(1000);
    chip.render(1000, out);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('leaves a 2A03-only render exactly as it was', () => {
    const writes = [
      { time: 0, address: 0x4015, value: 0x0f },
      { time: 0, address: 0x4000, value: 0xbf },
      { time: 0, address: 0x4002, value: 0xfd },
      { time: 0, address: 0x4003, value: 0x00 },
    ];
    const a = renderWrites(writes, 0.1);
    const b = renderWrites(writes, 0.1, { expansion: [] });
    expect(Array.from(a.samples)).toEqual(Array.from(b.samples));
  });
});

describe('N163', () => {
  it('reads and writes its RAM through the ports, with auto-increment', () => {
    const chip = new N163Chip(48000);
    chip.write(0xf800, 0x80 | 0x10);
    chip.write(0x4800, 0x12);
    chip.write(0x4800, 0x34);
    chip.write(0xf800, 0x80 | 0x10);
    expect([chip.read(), chip.read()]).toEqual([0x12, 0x34]);
  });

  it('plays a channel at CPU_HZ · f / (15 · 65536 · channels · length)', () => {
    const apu = new Apu(96000, { expansion: ['N163'] });
    const n163 = apu.n163!;
    // Wave: 32 samples at nibble 0; one channel on (slot 7).
    n163.write(0xf800, 0x80);
    for (let n = 0; n < 32; n += 2) n163.write(0x4800, SQUARE32[n] | (SQUARE32[n + 1] << 4));
    const freq = Math.round((220 * 15 * 65536 * 1 * 32) / 1789772.7272727273);
    n163.write(0xf800, 0x80 | 0x78);
    for (const b of [freq & 0xff, (freq >> 8) & 0xff, (256 - 32) | (freq >> 16), 0, 0, 0, 0, 0x0f]) n163.write(0x4800, b);
    const snapshot = apu.snapshot().n163!;
    expect(snapshot.channels).toBe(1);
    expect(snapshot.active[0]).toMatchObject({ slot: 7, length: 32, volume: 15 });
    const out = new Float64Array(96000 / 2);
    n163.render(out.length, [undefined, undefined, undefined, undefined, undefined, undefined, undefined, out]);
    const samples = Float32Array.from(out);
    expect(pitchOf(samples, 96000)).toBeCloseTo(n163Hz(freq, 32, 1), -1);
  });
});

describe('expansion notes', () => {
  const row = (channel: number, midi: number, wave: number): PitchedRow => {
    const hz = 440 * Math.pow(2, (midi - 69) / 12);
    return [midi, 0, 64, channel, 15, Math.round(hz * 100), 0, 15, 0, -1, -1, -1, -1, wave];
  };

  it('sound an FDS note at its pitch, from its wave', () => {
    const r = renderNotes({ pitched: [row(EXPANSION_CHANNELS.fds, 69, 0)], drums: [], waves: [SINE64], secondsPerTick: 1 / 64, totalTicks: 64 });
    expect(pitchOf(r.samples, r.sampleRate)).toBeGreaterThan(430);
    expect(pitchOf(r.samples, r.sampleRate)).toBeLessThan(450);
  });

  it('sound N163 notes on two channels, each at its pitch', () => {
    for (const channel of [EXPANSION_CHANNELS.n163[0], EXPANSION_CHANNELS.n163[1]]) {
      const others = channel === EXPANSION_CHANNELS.n163[1] ? [row(EXPANSION_CHANNELS.n163[0], 57, 0)] : [];
      const r = renderNotes(
        { pitched: [...others, row(channel, 69, 0)], drums: [], waves: [SQUARE32], secondsPerTick: 1 / 64, totalTicks: 64 },
        // Only the channel under test: the other one faded out.
        { voiceLevels: Array.from({ length: 14 }, (_, v) => (v === channel ? 1 : 0)) }
      );
      expect(pitchOf(r.samples, r.sampleRate)).toBeGreaterThan(430);
      expect(pitchOf(r.samples, r.sampleRate)).toBeLessThan(450);
    }
  });
});
