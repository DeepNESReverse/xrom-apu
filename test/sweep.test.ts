import { describe, expect, it } from 'vitest';
import { CPU_HZ, SWEEP_HZ, renderNotes as renderApu, sweepTrace, type DrumRow, type PitchedRow } from '../src/index.js';

/**
 * The sweep unit, measured rather than trusted.
 *
 * It was missing for a while and nothing on screen said so: 38 of the game's 84
 * sound effects enable it, and without it they play as flat beeps — right pitch
 * at the start, right length, and the whole gesture gone. The four effects that
 * sounded correct were exactly the four with the sweep switched off, which is
 * how the gap was found.
 *
 * Every test here therefore measures the rendered samples, because "sounds about
 * right" is the standard that let the missing sweep survive listening sessions.
 */

/** One pulse note for a whole second, with a `$4001` byte. */
const sweptNote = (period: number, sweep: number, channel = 0, seconds = 1) => {
  const row: PitchedRow = [60, 0, 1, channel, 15, period, 2, 15, 0, -1, -1, sweep];
  return {
    pitched: [row],
    drums: [] as DrumRow[],
    secondsPerTick: seconds,
    totalTicks: 1,
  };
};

/** Rising crossings of the midpoint, over one slice of the buffer. */
function measureHz(samples: Float32Array, sampleRate: number, from = 0, to = 1): number {
  const begin = Math.floor(samples.length * from);
  const end = Math.floor(samples.length * to);
  const slice = samples.subarray(begin, end);
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of slice) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
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
  if (crossings < 2) return 0;
  return ((crossings - 1) * sampleRate) / (last - first);
}

const peak = (samples: Float32Array, from = 0, to = 1) => {
  const begin = Math.floor(samples.length * from);
  const end = Math.floor(samples.length * to);
  let max = 0;
  for (let i = begin; i < end; i++) max = Math.max(max, Math.abs(samples[i]));
  return max;
};

describe('the sweep unit slides the period', () => {
  it('falls in pitch when the period is ADDED to', () => {
    // $83: enabled, divider 0 (acts every half-frame), add, shift 3. Adding to
    // the period lowers the pitch — the direction that reads as wrong until you
    // remember the register holds a divider, not a frequency.
    // Sampled at 0.10..0.13s, not later: the same register mutes the channel at
    // 0.17s (the test below), so a window past that measures silence.
    const render = renderApu(sweptNote(159, 0x83), { oversample: 1, filters: false });
    const start = measureHz(render.samples, render.sampleRate, 0, 0.02);
    const later = measureHz(render.samples, render.sampleRate, 0.1, 0.13);
    expect(start).toBeGreaterThan(400);
    expect(later).toBeGreaterThan(0);
    expect(later).toBeLessThan(start / 2);
  });

  it('rises in pitch when the period is SUBTRACTED from', () => {
    // $8B: enabled, divider 0, negate, shift 3.
    const render = renderApu(sweptNote(400, 0x8b), { oversample: 1, filters: false });
    const start = measureHz(render.samples, render.sampleRate, 0, 0.02);
    const later = measureHz(render.samples, render.sampleRate, 0.05, 0.08);
    expect(start).toBeGreaterThan(0);
    expect(later).toBeGreaterThan(start * 1.5);
  });

  it('leaves the pitch alone when the enable bit is clear', () => {
    // $0B is $8B without bit 7. Same shift, same direction, no movement — which
    // is what makes the 46 effects with a disabled sweep sound right already.
    const render = renderApu(sweptNote(400, 0x0b), { oversample: 1, filters: false });
    const expected = CPU_HZ / (16 * 401);
    const start = measureHz(render.samples, render.sampleRate, 0, 0.2);
    const later = measureHz(render.samples, render.sampleRate, 0.7, 0.9);
    expect(start).toBeGreaterThan(expected * 0.98);
    expect(start).toBeLessThan(expected * 1.02);
    expect(later).toBeGreaterThan(expected * 0.98);
    expect(later).toBeLessThan(expected * 1.02);
  });

  it('acts once every divider period + 1 half-frames', () => {
    // Same shift and direction, divider 0 against divider 7: the slow one has to
    // still be near where it started when the fast one has run away.
    const fast = renderApu(sweptNote(159, 0x83), { oversample: 1, filters: false });
    const slow = renderApu(sweptNote(159, 0xf3), { oversample: 1, filters: false });
    const at = (r: ReturnType<typeof renderApu>) => measureHz(r.samples, r.sampleRate, 0.08, 0.12);
    expect(at(slow)).toBeGreaterThan(at(fast) * 1.5);
  });
});

describe('the sweep unit mutes the channel', () => {
  it('is silent at a period below 8, enabled or not', () => {
    // Not a rounding detail: the effects reach periods of 6 and 7, and on the
    // hardware those do not sound at all.
    for (const sweep of [0x08, 0x88]) {
      const render = renderApu(sweptNote(6, sweep), { oversample: 1, filters: false });
      expect(peak(render.samples), `sweep $${sweep.toString(16)}`).toBe(0);
    }
  });

  it('goes silent once a rising target passes $7FF', () => {
    // $83 from 159 reaches a target over $7FF in about 21 half-frames — 175ms —
    // so a one-second note is sounding at the start and silent at the end. This
    // is the sweep cutting the sound short, not the length counter.
    const render = renderApu(sweptNote(159, 0x83), { oversample: 1, filters: false });
    expect(peak(render.samples, 0, 0.1)).toBeGreaterThan(0);
    expect(peak(render.samples, 0.5, 1)).toBe(0);
  });

  it('mutes on an overflowing target even with the unit disabled', () => {
    // The target is computed whether or not the unit is enabled, and shift 0 in
    // add mode doubles the period — so a period over $3FF mutes a channel that
    // is not sweeping at all. $00 is a real value in this ROM's effect headers.
    const loud = renderApu(sweptNote(0x300, 0x00), { oversample: 1, filters: false });
    const silent = renderApu(sweptNote(0x500, 0x00), { oversample: 1, filters: false });
    expect(peak(loud.samples)).toBeGreaterThan(0);
    expect(peak(silent.samples)).toBe(0);
  });

  it('does nothing at all when no $4001 is supplied', () => {
    // The music export carries no sweep register, so its rows must render exactly
    // as they did before the unit existed — including the periods that the mute
    // rules would otherwise silence.
    const row: PitchedRow = [60, 0, 1, 0, 15, 0x500, 2, 15, 0, -1, -1];
    const render = renderApu(
      { pitched: [row], drums: [], secondsPerTick: 1, totalTicks: 1 },
      { oversample: 1, filters: false }
    );
    expect(peak(render.samples)).toBeGreaterThan(0);
  });
});

describe('the sweep unit belongs to the pulse channels', () => {
  it('is ignored on the triangle, which has no such register', () => {
    // `$4008` is a linear counter, not a sweep. A `$4001` byte reaching channel 2
    // must neither bend it nor mute it.
    const render = renderApu(sweptNote(400, 0x83, 2), { oversample: 1, filters: false });
    const expected = CPU_HZ / (32 * 401);
    const start = measureHz(render.samples, render.sampleRate, 0, 0.2);
    const later = measureHz(render.samples, render.sampleRate, 0.7, 0.9);
    expect(start).toBeGreaterThan(expected * 0.95);
    expect(later).toBeGreaterThan(expected * 0.95);
    expect(later).toBeLessThan(expected * 1.05);
  });

  it('subtracts one more on pulse 1 than on pulse 2', () => {
    // A hardware asymmetry — one's complement against two's — and audible at the
    // short periods these effects use. Pulse 1 therefore ends up slightly higher
    // in pitch than pulse 2 given the same register.
    const one = renderApu(sweptNote(64, 0x8f, 0), { oversample: 1, filters: false });
    const two = renderApu(sweptNote(64, 0x8f, 1), { oversample: 1, filters: false });
    const at = (r: ReturnType<typeof renderApu>) => measureHz(r.samples, r.sampleRate, 0, 0.05);
    expect(at(one)).toBeGreaterThan(at(two));
  });
});

describe('sweepTrace — the same unit, for the picture', () => {
  it('follows the period the synth plays', () => {
    // The trace is what `/sfx` draws its period line from, so it has to agree
    // with the sound. Checked against the rendered buffer rather than against a
    // second calculation: $83 from 159, sampled a tenth of a second in.
    const trace = sweepTrace(159, 0x83, 0, Math.round(SWEEP_HZ * 0.12));
    const at = trace[Math.round(SWEEP_HZ * 0.11)];
    expect(at).not.toBeNull();
    const traceHz = CPU_HZ / (16 * ((at as number) + 1));

    const render = renderApu(sweptNote(159, 0x83), { oversample: 1, filters: false });
    const measured = measureHz(render.samples, render.sampleRate, 0.1, 0.13);
    expect(measured).toBeGreaterThan(traceHz * 0.9);
    expect(measured).toBeLessThan(traceHz * 1.1);
  });

  it('reports null where the unit mutes the channel', () => {
    const trace = sweepTrace(159, 0x83, 0, SWEEP_HZ);
    expect(trace[0]).toBe(159);
    expect(trace.at(-1)).toBeNull();
    // Muted once and staying muted: a gap in the middle would mean the period
    // came back down, which an add-mode sweep cannot do.
    const firstNull = trace.findIndex((value) => value === null);
    expect(trace.slice(firstNull).every((value) => value === null)).toBe(true);
  });

  it('is flat with no sweep byte, and on the triangle', () => {
    expect(sweepTrace(400, undefined, 0, 4)).toEqual([400, 400, 400, 400]);
    expect(sweepTrace(400, 0x83, 2, 4)).toEqual([400, 400, 400, 400]);
  });
});
