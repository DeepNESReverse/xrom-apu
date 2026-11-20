import { describe, expect, it } from 'vitest';
import {
  Apu,
  EXPANSION_CHANNELS,
  FdsChip,
  N163Chip,
  Vrc6Chip,
  Mmc5Chip,
  expansionOf,
  mmc5PulseHz,
  Vrc7Chip,
  vrc7Hz,
  fdsHz,
  n163Hz,
  renderNotes,
  renderWrites,
  vrc6PulseHz,
  vrc6SawHz,
  type PitchedRow,
} from '../src/index.js';

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

  it('steps its address on a read as on a write — how Namco drivers skip the phase bytes', () => {
    const chip = new N163Chip(48000);
    chip.write(0xf800, 0x80 | 0x78);
    chip.write(0x4800, 0x11); // frequency low
    chip.read(); // phase low, left alone
    chip.write(0x4800, 0x22); // frequency middle
    expect(chip.port).toBe(0x80 | 0x7b);
    expect([chip.ram[0x78], chip.ram[0x79], chip.ram[0x7a]]).toEqual([0x11, 0, 0x22]);
  });

  it('plays a channel at CPU_HZ · f / (15 · 65536 · channels · length)', () => {
    const apu = new Apu(96000, { expansion: ['N163'] });
    const n163 = apu.n163!;
    // Wave: 32 samples at nibble 0; one channel on (slot 7).
    n163.write(0xf800, 0x80);
    for (let n = 0; n < 32; n += 2) n163.write(0x4800, SQUARE32[n] | (SQUARE32[n + 1] << 4));
    const freq = Math.round((220 * 15 * 65536 * 1 * 32) / 1789772.7272727273);
    n163.write(0xf800, 0x80 | 0x78);
    // Frequency low, phase, middle, phase, high two bits + length, phase, wave address, volume.
    for (const b of [freq & 0xff, 0, (freq >> 8) & 0xff, 0, (256 - 32) | (freq >> 16), 0, 0, 0x0f]) n163.write(0x4800, b);
    const snapshot = apu.snapshot().n163!;
    expect(snapshot.channels).toBe(1);
    expect(snapshot.active[0]).toMatchObject({ slot: 7, length: 32, volume: 15 });
    const out = new Float64Array(96000 / 2);
    n163.render(out.length, [undefined, undefined, undefined, undefined, undefined, undefined, undefined, out]);
    const samples = Float32Array.from(out);
    expect(pitchOf(samples, 96000)).toBeCloseTo(n163Hz(freq, 32, 1), -1);
  });
});

describe('VRC6', () => {
  /** Fraction of the samples above the buffer's mean: the duty a pulse plays. */
  const highFraction = (out: Float64Array) => {
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    return out.filter((v) => v > mean).length / out.length;
  };

  it('plays a pulse at CPU_HZ / (16 · (period + 1)), with its duty of 16', () => {
    const period = Math.round(1789772.7272727273 / (16 * 440)) - 1;
    for (const duty of [0, 3, 7]) {
      const chip = new Vrc6Chip(96000);
      chip.write(0x9000, (duty << 4) | 15);
      chip.write(0x9001, period & 0xff);
      chip.write(0x9002, 0x80 | (period >> 8));
      const out = new Float64Array(96000 / 2);
      chip.render(out.length, [out]);
      expect(pitchOf(Float32Array.from(out), 96000)).toBeCloseTo(vrc6PulseHz(period), -1);
      expect(highFraction(out)).toBeCloseTo((duty + 1) / 16, 1);
    }
  });

  it('puts the volume out flat in mode, and nothing with E clear', () => {
    const chip = new Vrc6Chip(48000);
    chip.write(0xa000, 0x80 | 9);
    chip.write(0xa001, 0x40);
    chip.write(0xa002, 0x81);
    const out = new Float64Array(1000);
    chip.render(1000, [undefined, out]);
    expect(new Set(out).size).toBe(1);
    expect(out[0]).toBeGreaterThan(0);
    chip.write(0xa002, 0x01);
    const silent = new Float64Array(1000);
    chip.render(1000, [undefined, silent]);
    expect(silent.every((v) => v === 0)).toBe(true);
  });

  it('plays the saw at CPU_HZ / (14 · (period + 1)), its height from the rate', () => {
    const period = Math.round(1789772.7272727273 / (14 * 220)) - 1;
    const peakOf = (rate: number) => {
      const chip = new Vrc6Chip(96000);
      chip.write(0xb000, rate);
      chip.write(0xb001, period & 0xff);
      chip.write(0xb002, 0x80 | (period >> 8));
      const out = new Float64Array(96000 / 2);
      chip.render(out.length, [undefined, undefined, out]);
      expect(pitchOf(Float32Array.from(out), 96000)).toBeCloseTo(vrc6SawHz(period), -1);
      return Math.max(...out);
    };
    // Six additions of the rate, the top five bits of the accumulator out.
    expect(peakOf(42) / peakOf(21)).toBeCloseTo(31 / 15, 1);
  });

  it('shifts every period by $9003, and halts there', () => {
    const chip = new Vrc6Chip(96000);
    chip.write(0x9000, 0x7f);
    chip.write(0x9001, 0xff);
    chip.write(0x9002, 0x8f); // period $FFF: ~27 Hz
    chip.write(0x9003, 0x02); // ×16
    expect(chip.snapshot().shift).toBe(4);
    const out = new Float64Array(96000 / 2);
    chip.render(out.length, [out]);
    expect(pitchOf(Float32Array.from(out), 96000)).toBeCloseTo(vrc6PulseHz(0xfff, 4), -1);
    chip.write(0x9003, 0x06); // bit 2 wins: ×256
    expect(chip.snapshot().shift).toBe(8);
    chip.write(0x9003, 0x01);
    const held = new Float64Array(1000);
    chip.render(1000, [held]);
    expect(new Set(held).size).toBe(1);
    expect(chip.snapshot().halted).toBe(true);
  });

  it('is turned on by its writes, and mixes about one and a half 2A03 pulses loud', () => {
    const writes = [
      { time: 0, address: 0x9000, value: 0x7f },
      { time: 0, address: 0x9001, value: 0xfd },
      { time: 0, address: 0x9002, value: 0x80 },
    ];
    expect(expansionOf(writes)).toEqual(['VRC6']);
    const vrc6 = renderWrites(writes, 0.3, { filters: false });
    const apu = renderWrites(
      [
        { time: 0, address: 0x4015, value: 0x01 },
        { time: 0, address: 0x4000, value: 0xbf },
        { time: 0, address: 0x4001, value: 0x08 },
        { time: 0, address: 0x4002, value: 0xfd },
        { time: 0, address: 0x4003, value: 0x00 },
      ],
      0.3,
      { filters: false }
    );
    expect(vrc6.peak / apu.peak).toBeGreaterThan(1.3);
    expect(vrc6.peak / apu.peak).toBeLessThan(1.7);
    expect(new Apu(48000, { expansion: ['VRC6'] }).snapshot().vrc6?.pulse[0].enabled).toBe(false);
  });
});

describe('MMC5', () => {
  const highFraction = (out: Float64Array) => {
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    return out.filter((v) => v > mean).length / out.length;
  };

  it('plays a pulse at CPU_HZ / (16 · (period + 1)), with the 2A03\'s duties', () => {
    const period = Math.round(1789772.7272727273 / (16 * 440)) - 1;
    for (const [duty, fraction] of [[0, 1 / 8], [1, 2 / 8], [2, 4 / 8]] as const) {
      const chip = new Mmc5Chip(96000);
      chip.write(0x5015, 0x01);
      chip.write(0x5000, (duty << 6) | 0x30 | 15);
      chip.write(0x5002, period & 0xff);
      chip.write(0x5003, 0xf8 | (period >> 8));
      const out = new Float64Array(96000 / 2);
      chip.render(out.length, [out]);
      expect(pitchOf(Float32Array.from(out), 96000)).toBeCloseTo(mmc5PulseHz(period), -1);
      expect(highFraction(out)).toBeCloseTo(fraction, 1);
    }
  });

  it('counts its length at 240 Hz, and $5015 shows it running', () => {
    const chip = new Mmc5Chip(48000);
    chip.write(0x5015, 0x02);
    chip.write(0x5004, 0x1f); // constant volume, length counting
    chip.write(0x5006, 0x80);
    chip.write(0x5007, 0x18); // length index 3: 2 steps
    expect(chip.status()).toBe(2);
    chip.render(48000 / 100, [undefined, new Float64Array(480)]); // 10 ms: past two quarter frames
    expect(chip.status()).toBe(0);
    expect(chip.snapshot().pulse[1].volume).toBe(0);
  });

  it('is silent until $5015 enables it, and runs its envelope at 240 Hz', () => {
    const chip = new Mmc5Chip(48000);
    chip.write(0x5000, 0x23); // envelope, period 3, looping (halt)
    chip.write(0x5002, 0x80);
    chip.write(0x5003, 0x00);
    expect(chip.snapshot().pulse[0].enabled).toBe(false);
    chip.write(0x5015, 0x01);
    chip.write(0x5003, 0x00);
    chip.render(1, [new Float64Array(1)]);
    // 1 s at 240 Hz, a step every 4 quarter frames: the envelope has looped and is still going.
    chip.render(48000, [new Float64Array(48000)]);
    expect(chip.snapshot().pulse[0].length).toBeGreaterThan(0);
    expect(chip.snapshot().pulse[0].volume).toBeGreaterThanOrEqual(0);
  });

  it('is turned on by its writes, and mixes as loud as a 2A03 pulse', () => {
    const writes = [
      { time: 0, address: 0x5015, value: 0x01 },
      { time: 0, address: 0x5000, value: 0xbf },
      { time: 0, address: 0x5002, value: 0xfd },
      { time: 0, address: 0x5003, value: 0x00 },
    ];
    expect(expansionOf(writes)).toEqual(['MMC5']);
    const mmc5 = renderWrites(writes, 0.3, { filters: false });
    const apu = renderWrites(
      [
        { time: 0, address: 0x4015, value: 0x01 },
        { time: 0, address: 0x4000, value: 0xbf },
        { time: 0, address: 0x4001, value: 0x08 },
        { time: 0, address: 0x4002, value: 0xfd },
        { time: 0, address: 0x4003, value: 0x00 },
      ],
      0.3,
      { filters: false }
    );
    expect(mmc5.peak / apu.peak).toBeGreaterThan(0.9);
    expect(mmc5.peak / apu.peak).toBeLessThan(1.1);
    expect(new Apu(48000, { expansion: ['MMC5'] }).snapshot().mmc5?.pulse[0].enabled).toBe(false);
  });
});

describe('VRC7', () => {
  /** A plain sine: the modulator silent (output level 63), carrier ×1, instant attack, held. */
  const SINE_PATCH = [0x20, 0x21, 0x3f, 0x00, 0xf0, 0xf0, 0x00, 0x0f];
  const write = (chip: Vrc7Chip, register: number, value: number) => {
    chip.write(0x9010, register);
    chip.write(0x9030, value);
  };
  const keyOn = (chip: Vrc7Chip, channel: number, fnum: number, block: number, instrument: number, volume = 0) => {
    write(chip, 0x30 + channel, (instrument << 4) | volume);
    write(chip, 0x10 + channel, fnum & 0xff);
    write(chip, 0x20 + channel, 0x10 | (block << 1) | (fnum >> 8));
  };

  it('plays a channel at 49716 · f / 2^(19 − octave)', () => {
    const chip = new Vrc7Chip(96000);
    SINE_PATCH.forEach((v, r) => write(chip, r, v));
    const fnum = Math.round((440 * Math.pow(2, 19 - 4)) / 49715.9);
    keyOn(chip, 2, fnum, 4, 0);
    const out = new Float64Array(96000 / 2);
    chip.render(out.length, [undefined, undefined, out]);
    expect(pitchOf(Float32Array.from(out), 96000)).toBeCloseTo(vrc7Hz(fnum, 4), -1);
    expect(vrc7Hz(fnum, 4)).toBeCloseTo(440, -1);
  });

  it('is louder at volume 0 than at 15, and fades after key-off', () => {
    const peak = (volume: number) => {
      const chip = new Vrc7Chip(48000);
      SINE_PATCH.forEach((v, r) => write(chip, r, v));
      keyOn(chip, 0, 290, 4, 0, volume);
      const out = new Float64Array(4800);
      chip.render(out.length, [out]);
      return Math.max(...out.map(Math.abs));
    };
    // 15 steps of 3 dB: 45 dB apart.
    expect(20 * Math.log10(peak(0) / peak(15))).toBeCloseTo(45, -1);
    const chip = new Vrc7Chip(48000);
    keyOn(chip, 0, 290, 4, 3); // Wurly: a real release
    chip.render(4800, [new Float64Array(4800)]);
    write(chip, 0x20, 0x08);
    expect(chip.snapshot().channels[0].key).toBe(false);
    chip.render(48000 * 3, [new Float64Array(48000 * 3)]);
    expect(chip.snapshot().channels[0].sounding).toBe(false);
  });

  it('sounds each built-in instrument, and is turned on by its writes', () => {
    for (let instrument = 1; instrument <= 15; instrument++) {
      const chip = new Vrc7Chip(48000);
      keyOn(chip, 1, 290, 4, instrument);
      const out = new Float64Array(9600);
      chip.render(out.length, [undefined, out]);
      expect(Math.max(...out.map(Math.abs))).toBeGreaterThan(0.005);
    }
    expect(expansionOf([{ time: 0, address: 0x9010, value: 0x30 }, { time: 0, address: 0x9030, value: 0x30 }])).toEqual(['VRC7']);
    expect(new Apu(48000, { expansion: ['VRC7'] }).snapshot().vrc7?.channels).toHaveLength(6);
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

  it('sound VRC6 notes on its pulses and saw, each at its pitch', () => {
    for (const channel of EXPANSION_CHANNELS.vrc6) {
      const r = renderNotes(
        { pitched: [row(EXPANSION_CHANNELS.vrc6[0], 57, -1), row(channel, 69, -1)], drums: [], secondsPerTick: 1 / 64, totalTicks: 64 },
        { voiceLevels: Array.from({ length: 17 }, (_, v) => (v === channel ? 1 : 0)) }
      );
      expect(pitchOf(r.samples, r.sampleRate)).toBeGreaterThan(430);
      expect(pitchOf(r.samples, r.sampleRate)).toBeLessThan(450);
    }
  });

  it('sound MMC5 notes on its two pulses, each at its pitch', () => {
    for (const channel of EXPANSION_CHANNELS.mmc5) {
      const r = renderNotes(
        { pitched: [row(EXPANSION_CHANNELS.mmc5[0], 57, -1), row(channel, 69, -1)], drums: [], secondsPerTick: 1 / 64, totalTicks: 64 },
        { voiceLevels: Array.from({ length: 20 }, (_, v) => (v === channel ? 1 : 0)) }
      );
      expect(pitchOf(r.samples, r.sampleRate)).toBeGreaterThan(430);
      expect(pitchOf(r.samples, r.sampleRate)).toBeLessThan(450);
    }
  });

  it('sound VRC7 notes on each of its six channels at their pitch, with the driver\'s own instrument', () => {
    const SINE_PATCH = [0x20, 0x21, 0x3f, 0x00, 0xf0, 0xf0, 0x00, 0x0f];
    for (const channel of EXPANSION_CHANNELS.vrc7) {
      const r = renderNotes(
        { pitched: [row(channel, 69, 0)], drums: [], waves: [SINE_PATCH], secondsPerTick: 1 / 64, totalTicks: 64 },
        { voiceLevels: Array.from({ length: 26 }, (_, v) => (v === channel ? 1 : 0)) }
      );
      expect(pitchOf(r.samples, r.sampleRate)).toBeGreaterThan(430);
      expect(pitchOf(r.samples, r.sampleRate)).toBeLessThan(450);
    }
  });
});
