import { describe, expect, it } from 'vitest';
import { notesToWrites, renderNotes, secondsToTick, tickToSeconds, type ApuInput } from '../src/index.js';

const base: ApuInput = { pitched: [], drums: [], secondsPerTick: 0.03, totalTicks: 100 };
const faster = { ...base, tempo: [{ tick: 0, secondsPerTick: 0.02 }, { tick: 70, secondsPerTick: 0.03 }] };

describe('tempo', () => {
  it('is tick × secondsPerTick without changes — the same float', () => {
    for (const tick of [0, 1, 7, 70, 99.5]) expect(tickToSeconds(base, tick)).toBe(tick * 0.03);
  });

  it('runs each stretch at its own speed', () => {
    expect(tickToSeconds(faster, 70)).toBeCloseTo(70 * 0.02, 12);
    expect(tickToSeconds(faster, 100)).toBeCloseTo(70 * 0.02 + 30 * 0.03, 12);
    // A change later on leaves the ticks before it at the starting speed.
    const late = { ...base, tempo: [{ tick: 50, secondsPerTick: 0.06 }] };
    expect(tickToSeconds(late, 50)).toBeCloseTo(1.5, 12);
    expect(tickToSeconds(late, 60)).toBeCloseTo(2.1, 12);
  });

  it('secondsToTick undoes it', () => {
    for (const tick of [0, 3.5, 69, 70, 71, 99]) expect(secondsToTick(faster, tickToSeconds(faster, tick))).toBeCloseTo(tick, 9);
  });

  it('moves the notes and the length with it', () => {
    const input: ApuInput = { ...faster, pitched: [[60, 80, 4, 0, 8, 200, 2, 8, 0, -1]] };
    const first = notesToWrites(input).find((w) => w.address === 0x4002)!;
    expect(first.time).toBeCloseTo(70 * 0.02 + 10 * 0.03, 12);
    expect(renderNotes(input).loopEnd).toBeCloseTo(70 * 0.02 + 30 * 0.03, 12);
  });
});
