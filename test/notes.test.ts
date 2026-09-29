import { describe, expect, it } from 'vitest';
import {
  CPU_HZ,
  DUTY_SEQUENCES,
  NOISE_PERIODS,
  bendAt,
  mixApu,
  renderNotes as renderApu,
  type BendCurve,
  type DrumRow,
  type PitchedRow,
} from '../src/index.js';

/** One note, alone, for a whole second at one tick per second. */
const oneNote = (
  over: Partial<Record<'channel' | 'volume' | 'period' | 'duty' | 'end' | 'length', number>>
) => {
  const channel = over.channel ?? 0;
  const row: PitchedRow = [
    60,
    0,
    1,
    channel,
    over.volume ?? 15,
    over.period ?? 253,
    over.duty ?? 2,
    over.end ?? over.volume ?? 15,
    over.length ?? 0,
    -1,
  ];
  return { pitched: [row], drums: [] as DrumRow[], secondsPerTick: 1, totalTicks: 1 };
};

/**
 * Frequency by counting rising crossings of the signal's own midpoint.
 *
 * Measuring rather than trusting is the point of the whole module: this is the
 * check that says the synth plays the period the ROM holds and not the MIDI
 * note we rounded it to.
 */
function measureHz(samples: Float32Array, sampleRate: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of samples) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  const mid = (lo + hi) / 2;
  let crossings = 0;
  let first = -1;
  let last = -1;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] <= mid && samples[i] > mid) {
      crossings++;
      if (first < 0) first = i;
      last = i;
    }
  }
  if (crossings < 2) return 0;
  return ((crossings - 1) * sampleRate) / (last - first);
}

describe('renderApu — pitch comes from the APU period', () => {
  it('plays a pulse at CPU / (16 × (period + 1))', () => {
    for (const period of [142, 253, 678]) {
      const render = renderApu(oneNote({ period }), { oversample: 1, filters: false });
      const expected = CPU_HZ / (16 * (period + 1));
      const measured = measureHz(render.samples, render.sampleRate);
      expect(measured, `period ${period}`).toBeGreaterThan(expected * 0.98);
      expect(measured, `period ${period}`).toBeLessThan(expected * 1.02);
    }
  });

  it('plays the triangle an octave below the pulse at the same period', () => {
    const period = 678;
    const pulse = renderApu(oneNote({ period, channel: 0 }), { oversample: 1, filters: false });
    const triangle = renderApu(oneNote({ period, channel: 2 }), { oversample: 1, filters: false });
    const pulseHz = measureHz(pulse.samples, pulse.sampleRate);
    const triangleHz = measureHz(triangle.samples, triangle.sampleRate);
    expect(triangleHz).toBeGreaterThan(0);
    expect(pulseHz / triangleHz).toBeGreaterThan(1.9);
    expect(pulseHz / triangleHz).toBeLessThan(2.1);
  });

  it('matches the frequency the parser reports for a real note', () => {
    // Arctic Caverns' pulse1 G5: period 142 in the ROM, 782.24 Hz on the chip —
    // NOT the 783.99 Hz that MIDI note 79 would be. Playing the MIDI note is
    // the mistake this data shape exists to prevent.
    const render = renderApu(oneNote({ period: 142 }), { oversample: 1, filters: false });
    expect(measureHz(render.samples, render.sampleRate)).toBeGreaterThan(770);
    expect(measureHz(render.samples, render.sampleRate)).toBeLessThan(795);
  });
});

describe('renderApu — levels', () => {
  it('is silent at volume 0', () => {
    const render = renderApu(oneNote({ volume: 0, end: 0 }), { oversample: 1 });
    expect(render.peak).toBe(0);
  });

  it('gets louder with volume', () => {
    const quiet = renderApu(oneNote({ volume: 3, end: 3 }), { oversample: 1, filters: false });
    const loud = renderApu(oneNote({ volume: 15, end: 15 }), { oversample: 1, filters: false });
    expect(loud.peak).toBeGreaterThan(quiet.peak * 1.5);
  });

  it('follows the driver envelope down to silence', () => {
    const render = renderApu(oneNote({ volume: 15, end: 0 }), { oversample: 1, filters: false });
    const samples = render.samples;
    const head = samples.slice(0, samples.length / 8);
    const tail = samples.slice(-Math.floor(samples.length / 8) - 10, -10);
    const peakOf = (xs: Float32Array) => Math.max(...Array.from(xs, Math.abs));
    expect(peakOf(head)).toBeGreaterThan(peakOf(tail) * 3);
  });

  it('never clips', () => {
    const loud = {
      pitched: [
        [60, 0, 1, 0, 15, 253, 2, 15, 0, -1],
        [60, 0, 1, 1, 15, 254, 2, 15, 0, -1],
        [40, 0, 1, 2, 12, 500, 0, 12, 0, -1],
      ] as PitchedRow[],
      drums: [[8, 0, 1, 15, 15, 0]] as DrumRow[],
      secondsPerTick: 1,
      totalTicks: 1,
    };
    const render = renderApu(loud, { oversample: 1, gain: 1, filters: false });
    expect(render.peak).toBeLessThanOrEqual(1);
    expect(render.peak).toBeGreaterThan(0.2);
  });

  it('turns a channel down with its fader, and off at zero', () => {
    const full = renderApu(oneNote({ volume: 15 }), { oversample: 1, filters: false });
    const half = renderApu(oneNote({ volume: 15 }), {
      oversample: 1,
      filters: false,
      voiceLevels: [0.5, 1, 1, 1],
    });
    const off = renderApu(oneNote({ volume: 15 }), {
      oversample: 1,
      filters: false,
      voiceLevels: [0, 1, 1, 1],
    });
    expect(half.peak).toBeLessThan(full.peak);
    expect(half.peak).toBeGreaterThan(0);
    expect(off.peak).toBe(0);
  });

  it('leaves the other channels where they were', () => {
    // The mixer is non-linear, so a fader on pulse 1 moving pulse 2 is a real
    // risk rather than a pedantic one — this is the check that it does not.
    const alone = renderApu(oneNote({ channel: 1, volume: 15 }), {
      oversample: 1,
      filters: false,
    });
    const withPulse1Down = renderApu(oneNote({ channel: 1, volume: 15 }), {
      oversample: 1,
      filters: false,
      voiceLevels: [0, 1, 1, 1],
    });
    expect(withPulse1Down.peak).toBeCloseTo(alone.peak, 6);
  });

  it('turns the triangle down, which the hardware itself cannot', () => {
    // The chip has no volume on the triangle — it sounds or it does not — so
    // this is the one level in the path that is the desk's rather than the
    // cartridge's, and it has to work.
    const triangle = { channel: 2, volume: 15, period: 500 };
    const full = renderApu(oneNote(triangle), { oversample: 1, filters: false });
    const down = renderApu(oneNote(triangle), {
      oversample: 1,
      filters: false,
      voiceLevels: [1, 1, 0.25, 1],
    });
    expect(down.peak).toBeLessThan(full.peak * 0.5);
    expect(down.peak).toBeGreaterThan(0);
  });

  it('mixes non-linearly — two pulses are not twice one', () => {
    const one = mixApu(15, 0, 0, 0);
    const two = mixApu(15, 15, 0, 0);
    expect(two).toBeGreaterThan(one);
    expect(two).toBeLessThan(one * 2);
  });
});

describe('renderApu — timbre and noise', () => {
  it('spends a different share of the cycle high per duty', () => {
    const share = (duty: number) => {
      const render = renderApu(oneNote({ duty, volume: 15, end: 15 }), {
        oversample: 1,
        filters: false,
      });
      const above = Array.from(render.samples).filter((value) => value > render.peak / 2).length;
      return above / render.samples.length;
    };
    // 12.5% and 25% are distinct; 75% is 25% inverted, so it holds the same
    // share high as 50% does not — this asserts the ordering, not exact ratios.
    expect(share(0)).toBeLessThan(share(1));
    expect(share(1)).toBeLessThan(share(2));
    expect(DUTY_SEQUENCES[3].filter(Boolean)).toHaveLength(6);
  });

  it('makes noise that does not repeat like a tone', () => {
    const render = renderApu(
      { pitched: [], drums: [[8, 0, 1, 15, 15, 0]], secondsPerTick: 1, totalTicks: 1 },
      { oversample: 1, filters: false }
    );
    expect(render.peak).toBeGreaterThan(0);

    // A tone correlates strongly with itself one period later; the LFSR should
    // not. Compare the best correlation over plausible lags against the signal's
    // own energy.
    const samples = render.samples.slice(1000, 9000);
    let energy = 0;
    for (const value of samples) energy += value * value;
    let best = 0;
    for (let lag = 20; lag < 800; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < samples.length; i++) sum += samples[i] * samples[i + lag];
      best = Math.max(best, Math.abs(sum));
    }
    expect(best / energy).toBeLessThan(0.9);
  });

  it('knows the sixteen noise periods', () => {
    expect(NOISE_PERIODS).toHaveLength(16);
    expect(NOISE_PERIODS[0]).toBe(4);
    expect(NOISE_PERIODS[15]).toBe(4068);
  });
});

describe('renderApu — shape of the output', () => {
  it('is silent for an empty piece, and the right length', () => {
    const render = renderApu(
      { pitched: [], drums: [], secondsPerTick: 0.05, totalTicks: 100 },
      { oversample: 1, sampleRate: 8000 }
    );
    expect(render.peak).toBe(0);
    expect(render.duration).toBeGreaterThan(5);
    expect(render.duration).toBeLessThan(5.2);
  });

  it('puts the lead-in silence before the first note', () => {
    const render = renderApu(oneNote({}), { oversample: 1, lead: 0.5, filters: false });
    const leadSamples = Math.round(0.5 * render.sampleRate);
    const before = render.samples.slice(0, leadSamples - 10);
    expect(Math.max(...Array.from(before, Math.abs))).toBe(0);
    expect(
      Math.max(...Array.from(render.samples.slice(leadSamples + 10), Math.abs))
    ).toBeGreaterThan(0);
  });

  it('skips a note with no period rather than dividing by zero', () => {
    const render = renderApu(
      { ...oneNote({}), pitched: [[60, 0, 1, 0, 15, 0, 2, 15, 0, -1]] as PitchedRow[] },
      { oversample: 1, filters: false }
    );
    expect(Number.isFinite(render.peak)).toBe(true);
    expect(render.peak).toBe(0);
  });
});

describe('the output filters', () => {
  const drumRoll = {
    pitched: [] as PitchedRow[],
    drums: [
      [8, 0, 2, 15, 15, 0],
      [8, 4, 2, 15, 15, 0],
      [13, 8, 2, 15, 15, 0],
    ] as DrumRow[],
    secondsPerTick: 0.035,
    totalTicks: 12,
  };

  const dc = (samples: Float32Array) =>
    Array.from(samples).reduce((sum, value) => sum + value, 0) / samples.length;

  it('centres the signal on zero — the mixer alone never goes negative', () => {
    const raw = renderApu(drumRoll, { oversample: 2, filters: false, gain: 1 });
    const filtered = renderApu(drumRoll, { oversample: 2 });

    // This is the whole bug the filters fix: a one-sided signal steps its DC
    // level at every note edge, and a step in DC IS a click.
    expect(Math.min(...Array.from(raw.samples))).toBeGreaterThanOrEqual(0);
    expect(dc(raw.samples)).toBeGreaterThan(0.02);

    expect(Math.abs(dc(filtered.samples))).toBeLessThan(0.001);
    expect(Math.min(...Array.from(filtered.samples))).toBeLessThan(0);
  });

  it('keeps the bass by default, and loses it with the console response on', () => {
    // The 440 Hz high-pass is real hardware and costs 18 dB at the triangle's
    // 82 Hz; `consoleBass` is opt-in for exactly that reason.
    const bass = {
      pitched: [[40, 0, 8, 2, 12, 678, 0, 12, 0, -1]] as PitchedRow[],
      drums: [] as DrumRow[],
      secondsPerTick: 0.035,
      totalTicks: 8,
    };
    const kept = renderApu(bass, { oversample: 2 });
    const withConsole = renderApu(bass, { oversample: 2, consoleBass: true });

    // By ENERGY, not by peak: a high-pass overshoots on the leading edge, so
    // the console-response version has the taller spike and far less of the
    // note. Peak would have reported the opposite of what is audible.
    const rms = (samples: Float32Array) =>
      Math.sqrt(Array.from(samples).reduce((sum, v) => sum + v * v, 0) / samples.length);
    expect(rms(kept.samples)).toBeGreaterThan(rms(withConsole.samples) * 2);
  });

  it('does not alias the noise — oversampling barely changes its spectrum', () => {
    // The LFSR runs at up to 14 kHz, several shifts per sample; taking the last
    // state instead of averaging folded that back as alias tones, which is what
    // made the drums sound broken. Compare a cheap render against a fine one.
    const hit = {
      pitched: [] as PitchedRow[],
      drums: [[6, 0, 40, 15, 15, 0]] as DrumRow[],
      secondsPerTick: 0.035,
      totalTicks: 40,
    };
    const bins = (samples: Float32Array, rate: number) => {
      const n = 4096;
      const from = Math.floor(samples.length / 3);
      const window = samples.slice(from, from + n);
      const out: number[] = [];
      for (let b = 0; b < 12; b++) {
        const hz = ((b + 0.5) * (rate / 2)) / 12;
        let re = 0;
        let im = 0;
        for (let i = 0; i < n; i++) {
          const angle = (2 * Math.PI * hz * i) / rate;
          re += window[i] * Math.cos(angle);
          im += window[i] * Math.sin(angle);
        }
        out.push(Math.hypot(re, im) / n);
      }
      const total = out.reduce((a, b) => a + b, 0) || 1;
      return out.map((v) => v / total);
    };
    const cheap = renderApu(hit, { oversample: 2 });
    const fine = renderApu(hit, { oversample: 16 });
    const a = bins(cheap.samples, cheap.sampleRate);
    const b = bins(fine.samples, fine.sampleRate);
    const difference = a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0);
    expect(difference).toBeLessThan(0.35);
  });
});

describe('the length counter', () => {
  /** A hit far longer than its counter — the shape the game actually writes. */
  const hit = (lengthTicks: number) => ({
    pitched: [] as PitchedRow[],
    drums: [[4, 0, 8, 8, 8, lengthTicks]] as DrumRow[],
    secondsPerTick: 0.049,
    totalTicks: 10,
  });

  const soundingSeconds = (samples: Float32Array, rate: number) => {
    let last = 0;
    for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > 0.002) last = i;
    return last / rate;
  };

  it('silences the channel when it runs out, mid-note', () => {
    // wookie hole: a 392ms note with a counter of 4 ticks — 33ms of sound and
    // the rest silence. Without this the drums are one continuous hiss, which
    // is exactly how they sounded before it was modelled.
    const render = renderApu(hit(4), { oversample: 1 });
    const sounded = soundingSeconds(render.samples, render.sampleRate);
    expect(sounded).toBeGreaterThan(0.02);
    expect(sounded).toBeLessThan(0.09);
  });

  it('leaves a note alone when the counter outlasts it', () => {
    const long = renderApu(hit(60), { oversample: 1 });
    expect(soundingSeconds(long.samples, long.sampleRate)).toBeGreaterThan(0.35);
  });

  it('is disabled by a zero counter, and by the option', () => {
    const none = renderApu(hit(0), { oversample: 1 });
    const off = renderApu(hit(4), { oversample: 1, lengthCounter: false });
    expect(soundingSeconds(none.samples, none.sampleRate)).toBeGreaterThan(0.35);
    expect(soundingSeconds(off.samples, off.sampleRate)).toBeGreaterThan(0.35);
  });
});

describe('pitch modulation', () => {
  /** A note whose pitch is pulled down a whole tone across its length. */
  const sliding = {
    pitched: [[60, 0, 8, 0, 15, 253, 2, 15, 0, 0]] as PitchedRow[],
    drums: [] as DrumRow[],
    bends: [
      [
        [0, 0],
        [1, -2],
      ],
    ] as BendCurve[],
    secondsPerTick: 0.05,
    totalTicks: 8,
  };

  const measureIn = (samples: Float32Array, rate: number, from: number, to: number) => {
    const window = samples.slice(Math.round(from * rate), Math.round(to * rate));
    return measureHz(window, rate);
  };

  it('bends the frequency along the curve', () => {
    const render = renderApu(sliding, { oversample: 1, filters: false });
    const head = measureIn(render.samples, render.sampleRate, 0.01, 0.06);
    const tail = measureIn(render.samples, render.sampleRate, 0.33, 0.38);

    // Two semitones down is a ratio of 2^(-2/12) — about 0.891.
    expect(head).toBeGreaterThan(0);
    expect(tail / head).toBeGreaterThan(0.86);
    expect(tail / head).toBeLessThan(0.93);
  });

  it('leaves a note without a curve at a steady pitch', () => {
    const steady = { ...sliding, pitched: [[60, 0, 8, 0, 15, 253, 2, 15, 0, -1]] as PitchedRow[] };
    const render = renderApu(steady, { oversample: 1, filters: false });
    const head = measureIn(render.samples, render.sampleRate, 0.01, 0.06);
    const tail = measureIn(render.samples, render.sampleRate, 0.33, 0.38);
    expect(tail / head).toBeGreaterThan(0.99);
    expect(tail / head).toBeLessThan(1.01);
  });

  it('reads the curve between its own points', () => {
    const curve: BendCurve = [
      [0, 0],
      [0.5, -6],
      [1, 0],
    ];
    expect(bendAt(curve, 0)).toBe(0);
    expect(bendAt(curve, 0.25)).toBeCloseTo(-3);
    expect(bendAt(curve, 0.5)).toBe(-6);
    expect(bendAt(curve, 0.75)).toBeCloseTo(-3);
    // Outside the curve it holds the ends rather than extrapolating.
    expect(bendAt(curve, 2)).toBe(0);
    expect(bendAt([], 0.5)).toBe(0);
  });
});

describe('the metronome', () => {
  const bars = {
    pitched: [] as PitchedRow[],
    drums: [] as DrumRow[],
    secondsPerTick: 0.05,
    totalTicks: 64,
  };

  it('clicks on the beat, and nowhere else', () => {
    const render = renderApu({ ...bars }, { oversample: 1, metronome: 16 });
    const rate = render.sampleRate;

    // Four quarter notes at 16 ticks each, 0.8s apart.
    const loudAt = (seconds: number) => {
      const from = Math.round(seconds * rate);
      const window = render.samples.slice(from, from + Math.round(0.02 * rate));
      return Math.max(...Array.from(window, Math.abs));
    };
    expect(loudAt(0)).toBeGreaterThan(0.05);
    expect(loudAt(0.8)).toBeGreaterThan(0.05);
    expect(loudAt(1.6)).toBeGreaterThan(0.05);
    // Between beats it has decayed to nothing.
    expect(loudAt(0.4)).toBeLessThan(0.01);
  });

  it('is silent when it is off', () => {
    expect(renderApu(bars, { oversample: 1 }).peak).toBe(0);
    expect(renderApu(bars, { oversample: 1, metronome: 0 }).peak).toBe(0);
  });

  it('marks the downbeat louder than the other beats', () => {
    const render = renderApu(bars, { oversample: 1, metronome: 16 });
    const rate = render.sampleRate;
    const peakAt = (seconds: number) => {
      const from = Math.round(seconds * rate);
      const window = render.samples.slice(from, from + Math.round(0.02 * rate));
      return Math.max(...Array.from(window, Math.abs));
    };
    expect(peakAt(0)).toBeGreaterThan(peakAt(0.8) * 1.2);
  });
});

describe('loop seam', () => {
  const input = (loopStart?: number) => ({
    pitched: oneNote({}).pitched,
    drums: [] as DrumRow[],
    secondsPerTick: 0.25,
    totalTicks: 8,
    ...(loopStart === undefined ? {} : { loopStart }),
  });

  it('starts the repeat at the top when the track has no intro', () => {
    const render = renderApu(input(), { sampleRate: 8000, filters: false });
    expect(render.loopStart).toBe(0);
    expect(render.loopEnd).toBeCloseTo(2, 6);
  });

  it('skips the one-time intro on the repeat', () => {
    // Four ticks of intro at a quarter-second each — the repeat comes back to
    // 1 s, not to 0, the way turbo tunnel race must not replay its half minute.
    const render = renderApu(input(4), { sampleRate: 8000, filters: false });
    expect(render.loopStart).toBeCloseTo(1, 6);
    expect(render.loopEnd).toBeCloseTo(2, 6);
  });

  it('counts the lead-in on both ends of the seam', () => {
    const render = renderApu(input(4), { sampleRate: 8000, filters: false, lead: 0.5 });
    expect(render.loopStart).toBeCloseTo(1.5, 6);
    expect(render.loopEnd).toBeCloseTo(2.5, 6);
  });

  it('never puts the seam past the end of the music', () => {
    const render = renderApu(input(99), { sampleRate: 8000, filters: false });
    expect(render.loopStart).toBeCloseTo(render.loopEnd, 6);
  });
});

describe("the chip's own envelope", () => {
  /** One noise hit, four seconds long at one tick per second. */
  const hit = (envelope: number, volume = 0): DrumRow => [4, 0, 4, volume, volume, 0, envelope];

  const render = (row: DrumRow) =>
    renderApu(
      { pitched: [], drums: [row], secondsPerTick: 1, totalTicks: 4 },
      { sampleRate: 8000, oversample: 1, filters: false, lengthCounter: false }
    );

  /** Loudest sample in a window, in seconds. */
  const peakIn = (samples: Float32Array, rate: number, from: number, to: number) => {
    let peak = 0;
    for (
      let i = Math.round(from * rate);
      i < Math.min(samples.length, Math.round(to * rate));
      i++
    ) {
      if (Math.abs(samples[i]) > peak) peak = Math.abs(samples[i]);
    }
    return peak;
  };

  it('sounds a note the driver wrote as volume zero', () => {
    // The whole of Intermission's drum track is this: `$400C` = $40, so the
    // level is not 0 but the chip's decay from 15.
    expect(render(hit(0)).peak).toBeGreaterThan(0);
    expect(render([4, 0, 4, 0, 0, 0, -1]).peak).toBe(0);
  });

  it('decays to silence in 15 steps at 240 Hz', () => {
    const { samples, sampleRate } = render(hit(0));
    // Period 0 steps every quarter frame: 15 of them is 62.5 ms.
    expect(peakIn(samples, sampleRate, 0, 0.05)).toBeGreaterThan(0);
    expect(peakIn(samples, sampleRate, 0.08, 1)).toBe(0);
  });

  it('takes longer with a longer divider period', () => {
    // Period 7 steps every 8 quarter frames: 15 of those is half a second.
    const { samples, sampleRate } = render(hit(7));
    expect(peakIn(samples, sampleRate, 0.4, 0.5)).toBeGreaterThan(0);
    expect(peakIn(samples, sampleRate, 0.55, 1)).toBe(0);
  });

  it('wraps instead of resting when the envelope loops', () => {
    const { samples, sampleRate } = render(hit(0x10));
    expect(peakIn(samples, sampleRate, 0.08, 1)).toBeGreaterThan(0);
  });

  it('leaves constant-volume notes to the driver', () => {
    const steady = render([4, 0, 4, 9, 9, 0, -1]);
    expect(peakIn(steady.samples, steady.sampleRate, 3, 4)).toBeGreaterThan(0);
  });
});
