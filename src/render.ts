/**
 * Register writes in, a finished buffer of samples out.
 *
 * Offline rather than scheduled live: a whole track is a few hundred
 * milliseconds of arithmetic, and a finished buffer is trivially in sync with
 * anything drawn over it — the playing position is one number both read.
 */

import { Apu } from './chip.js';
import { mixApu, OutputFilters } from './mixer.js';

/** One CPU write to an APU register, at a moment in seconds from the start. */
export interface RegisterWrite {
  time: number;
  address: number;
  value: number;
}

/** A metronome click: ours, not the chip's, so it is mixed after the console's filters. */
export interface Click {
  time: number;
  /** The downbeat: higher and louder. */
  strong: boolean;
}

export interface RenderOptions {
  sampleRate?: number;
  /**
   * Run the chip at this multiple of the sample rate and average down. A square
   * wave has infinite harmonics, so at 44.1 kHz the high notes alias into
   * inharmonic tones; 2× costs twice the arithmetic and takes most of it away.
   */
  oversample?: number;
  /** Master level. Default 2.2 — the high-passes centre the signal and cost level. */
  gain?: number;
  /**
   * A fader per channel, `[pulse1, pulse2, triangle, noise]`, 0..1. Default all 1.
   *
   * Applied to each channel's level BEFORE the non-linear mixer, the only place
   * a per-channel level can go: the mixer's whole point is that the channels
   * are not independent. The console has no such control — the triangle has no
   * volume at all — so this is a desk in front of the chip, for hearing one
   * voice on its own.
   */
  voiceLevels?: readonly number[];
  /** Skip the output filters. For tests that want the raw mixer. */
  filters?: boolean;
  /** Add the console's second high-pass at 440 Hz — see `OutputFilters`. */
  consoleBass?: boolean;
  /** Honour the length counters. Default true. */
  lengthCounter?: boolean;
  /** Metronome clicks to mix in after the filters. */
  clicks?: readonly Click[];
  /** Seconds rendered past `duration` so the filters can ring out. Default 0.05. */
  tail?: number;
}

export interface Render {
  samples: Float32Array;
  sampleRate: number;
  /** Length of the whole buffer, tail included, in seconds. */
  duration: number;
  /** Loudest absolute sample, before clamping. A value over 1 means the buffer was clamped. */
  peak: number;
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/**
 * Play `writes` through the chip for `duration` seconds.
 *
 * Writes may come in any order; ones at the same moment are applied in the
 * order given, which matters — `$4015` has to enable a channel before the
 * write that loads its length counter.
 */
export function renderWrites(
  writes: readonly RegisterWrite[],
  duration: number,
  options: RenderOptions = {}
): Render {
  const sampleRate = options.sampleRate ?? 44100;
  const oversample = Math.max(1, Math.round(options.oversample ?? 2));
  const gain = options.gain ?? 2.2;
  const faders = options.voiceLevels;
  const filtered = options.filters !== false;
  const rate = sampleRate * oversample;
  const total = Math.ceil(duration * rate) + Math.ceil(rate * (options.tail ?? 0.05));

  const ordered = writes
    .map((write, index) => ({ at: Math.max(0, Math.round(write.time * rate)), index, write }))
    .sort((a, b) => a.at - b.at || a.index - b.index);

  const chip = new Apu(rate, { lengthCounter: options.lengthCounter });
  const filters = new OutputFilters(rate, options.consoleBass ?? false);
  const out = new Float32Array(Math.ceil(total / oversample));

  const clicks = [...(options.clicks ?? [])]
    .map((click) => ({ at: Math.round(click.time * rate), strong: click.strong }))
    .sort((a, b) => a.at - b.at);
  const clickLength = Math.round(rate * 0.03);
  let clickCursor = 0;

  let next = 0;
  let peak = 0;
  let accumulator = 0;
  let written = 0;

  for (let sample = 0; sample < total; sample++) {
    while (next < ordered.length && ordered[next].at <= sample) {
      const { write } = ordered[next++];
      chip.write(write.address, write.value);
    }

    const levels = chip.levels();
    const mixed = faders
      ? mixApu(
          levels[0] * (faders[0] ?? 1),
          levels[1] * (faders[1] ?? 1),
          levels[2] * (faders[2] ?? 1),
          levels[3] * (faders[3] ?? 1)
        )
      : mixApu(levels[0], levels[1], levels[2], levels[3]);
    // Filtered at the oversampled rate: the low-pass then doubles as the
    // anti-aliasing filter the decimation needs.
    let value = filtered ? filters.step(mixed) : mixed;

    while (clickCursor < clicks.length && sample >= clicks[clickCursor].at + clickLength) {
      clickCursor++;
    }
    const click = clicks[clickCursor];
    if (click && sample >= click.at) {
      // A decaying sine, added AFTER the console's filters: running it through
      // them would colour it as if it came out of the cartridge.
      const into = (sample - click.at) / clickLength;
      const hz = click.strong ? 1600 : 1050;
      value +=
        Math.sin((2 * Math.PI * hz * (sample - click.at)) / rate) *
        Math.pow(1 - into, 3) *
        (click.strong ? 0.22 : 0.14);
    }

    accumulator += value;

    if ((sample + 1) % oversample === 0) {
      // Clamped, not scaled: the filters can overshoot a little on a hard
      // transient. `peak` reports what it was BEFORE the clamp.
      const averaged = (accumulator / oversample) * gain;
      accumulator = 0;
      if (Math.abs(averaged) > peak) peak = Math.abs(averaged);
      if (written < out.length) out[written++] = clamp(averaged, -1, 1);
    }
  }

  return { samples: out, sampleRate, duration: out.length / sampleRate, peak };
}
