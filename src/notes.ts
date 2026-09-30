/**
 * Notes in, register writes out — the adapter between a decoded score and the
 * chip.
 *
 * A music driver's job is to turn its own data into register writes, once a
 * frame. When a game's music has already been decoded into notes (start, length,
 * period, volume, duty, and how each of those moves), this plays the driver's
 * part: it writes what a driver would have written to sound those notes, and
 * `renderWrites` does the rest. So the chip never learns what a note is, and
 * anything the adapter gets wrong is visible as a register write rather than
 * hidden inside a synth.
 *
 * The note shape is the one xrom.dev exports for Battletoads, but nothing in it
 * is that game's: a tick is whatever the caller says it is in seconds.
 *
 * What it writes, per note:
 *  - at the start, the channel's full register set — which on a pulse restarts
 *    the duty sequencer and the envelope and reloads the length counter,
 *    exactly as the driver's own `$4003` write does;
 *  - once a frame after that, the level while it ramps and the period while it
 *    bends, as whole numbers, because the registers hold whole numbers — so a
 *    fade is a staircase at 60 Hz, as it is on the console;
 *  - at the end, silence — unless the next note on the channel starts at the
 *    same moment.
 */

import { FRAME_HZ, LENGTH_TABLE } from './constants.js';
import { renderWrites, type Click, type RegisterWrite, type RenderOptions } from './render.js';

/**
 * `[midi, startTick, durationTicks, channel 0..2, volume, period, duty,
 * volumeEnd, lengthTicks, bendIndex, envelope, sweep]` — `lengthTicks` counts at
 * 120 Hz and 0 means unlimited; `bendIndex` points into `ApuInput.bends`, or is
 * -1; `envelope` is the low five bits of `$4000` when the chip's own envelope
 * runs (period, and bit 4 for loop), or -1 for constant volume; `sweep` is the
 * `$4001` byte, or -1/absent when the data has none.
 */
export type PitchedRow = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number?,
  number?,
];

/** A pitch curve: `[position 0..1, semitones]`, in order. */
export type BendCurve = readonly (readonly [number, number])[];

/**
 * `[periodIndex, startTick, durationTicks, volume, volumeEnd, lengthTicks,
 * envelope]` — a noise-channel note. `periodIndex` is the low nibble of `$400E`.
 */
export type DrumRow = readonly [number, number, number, number, number, number, number?];

export interface ApuInput {
  pitched: readonly PitchedRow[];
  drums: readonly DrumRow[];
  /** Pitch curves the notes point at. Shared, because the shapes repeat. */
  bends?: readonly BendCurve[];
  /** Seconds per tick. */
  secondsPerTick: number;
  /** Length of the piece in ticks. */
  totalTicks: number;
  /**
   * Where the repeat starts, in ticks. Not always 0: a driver's first ticks are
   * often one-time setup, so a track that loops on the whole buffer replays its
   * intro every time round. Absent means the piece does not loop.
   */
  loopStart?: number;
  /**
   * Changes of tempo, as `{ tick, secondsPerTick }` in tick order: from `tick`
   * on, a tick lasts `secondsPerTick`. Before the first change it is the
   * input's own `secondsPerTick`. For drivers with a tempo command — Battletoads
   * speeds its opening up this way — whose ticks are not all the same length.
   */
  tempo?: readonly TempoChange[];
}

export interface TempoChange {
  tick: number;
  secondsPerTick: number;
}

/**
 * Seconds from the start to `tick`, through the tempo changes. With none it is
 * exactly `tick * secondsPerTick` — the same float, so a piece without changes
 * renders as it always has.
 */
export function tickToSeconds(input: Pick<ApuInput, 'secondsPerTick' | 'tempo'>, tick: number): number {
  const changes = input.tempo;
  if (!changes || changes.length === 0) return tick * input.secondsPerTick;
  let seconds = 0;
  let from = 0;
  let spt = input.secondsPerTick;
  for (const change of changes) {
    if (change.tick >= tick) break;
    seconds += (change.tick - from) * spt;
    from = change.tick;
    spt = change.secondsPerTick;
  }
  return seconds + (tick - from) * spt;
}

/** The tick at `seconds` — the inverse of `tickToSeconds`, fractional. */
export function secondsToTick(input: Pick<ApuInput, 'secondsPerTick' | 'tempo'>, seconds: number): number {
  const changes = input.tempo;
  if (!changes || changes.length === 0) return seconds / input.secondsPerTick;
  let at = 0;
  let from = 0;
  let spt = input.secondsPerTick;
  for (const change of changes) {
    const end = at + (change.tick - from) * spt;
    if (end >= seconds) break;
    at = end;
    from = change.tick;
    spt = change.secondsPerTick;
  }
  return from + (seconds - at) / spt;
}

export interface ApuOptions extends Omit<RenderOptions, 'clicks' | 'tail'> {
  /** Seconds of silence before the first note. */
  lead?: number;
  /** Click on every `metronome` ticks, loud on every fourth. 0 is off. */
  metronome?: number;
}

export interface ApuRender {
  samples: Float32Array;
  sampleRate: number;
  /** Seconds of silence before tick 0 — what the caller asked for as `lead`. */
  lead: number;
  /** Length of the whole buffer, tail included. */
  duration: number;
  /**
   * Where the music itself ends, in seconds — the loop point. The buffer runs a
   * little longer so the filters can ring out; looping on the buffer would play
   * that tail as a gap every time round.
   */
  loopEnd: number;
  /** Where the repeat starts, in seconds — the other end of the seam. */
  loopStart: number;
  /** Loudest absolute sample, before clamping. */
  peak: number;
}

/**
 * Semitones at `position` through a note, straight-line between the curve's own
 * points; outside it, the nearest end.
 */
export function bendAt(curve: BendCurve, position: number): number {
  if (curve.length === 0) return 0;
  if (position <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (position <= x1) {
      const [x0, y0] = curve[i - 1];
      const span = x1 - x0;
      return span <= 0 ? y1 : y0 + ((y1 - y0) * (position - x0)) / span;
    }
  }
  return curve[curve.length - 1][1];
}

/** Length-counter load → the index `$4003`'s top five bits must hold for it. */
const lengthIndex = (halfFrames: number) => {
  const index = LENGTH_TABLE.indexOf(halfFrames as (typeof LENGTH_TABLE)[number]);
  if (index < 0) throw new Error(`no length-table entry loads ${halfFrames} half-frames`);
  return index;
};

/** The longest load, 254 half-frames (2.1 s) — for a note with no counter that cannot halt it. */
const LONGEST = 1;

/** The `$4015` value: pulses and noise always on; the triangle toggled to end its notes. */
const enables = (triangle: boolean) => 0x0b | (triangle ? 0x04 : 0);

/** A register value can only hold whole numbers; a period outside 11 bits is not one the chip has. */
const toPeriod = (value: number) => Math.min(0x7ff, Math.max(0, Math.round(value)));

interface Voice {
  start: number;
  end: number;
  row: PitchedRow | DrumRow;
}

/**
 * The bits `$4000`/`$400C` share, from a row's envelope and length counter.
 *
 * Bit 5 is one bit with two jobs — it halts the length counter AND loops the
 * envelope — so a note that wants its envelope to decay once cannot also have
 * an unlimited counter. The rows that ask for both (`lengthTicks` 0 with a
 * one-shot envelope) get the longest load the table has instead, which outlasts
 * any note the envelope has not already silenced.
 */
function controlBits(envelope: number, lengthTicks: number) {
  if (envelope >= 0) {
    const loop = (envelope & 0x10) !== 0;
    return {
      halt: loop,
      load: lengthTicks > 0 ? lengthIndex(lengthTicks) : LONGEST,
      low: envelope & 0x0f,
      constant: false,
    };
  }
  return {
    halt: lengthTicks === 0,
    load: lengthTicks > 0 ? lengthIndex(lengthTicks) : 0,
    low: 0,
    constant: true,
  };
}

/** Frame moments inside a note, after its start: when a driver would next touch it. */
function* frames(start: number, end: number) {
  for (let k = 1; ; k++) {
    const time = start + k / FRAME_HZ;
    if (time >= end) return;
    yield { time, position: (time - start) / (end - start) };
  }
}

/**
 * The writes that play `input`, as a driver would make them.
 *
 * @param lead seconds of silence before tick 0
 */
export function notesToWrites(input: ApuInput, lead = 0): RegisterWrite[] {
  const at = (tick: number) => tickToSeconds(input, tick);
  const bends = input.bends ?? [];
  const writes: RegisterWrite[] = [];
  const put = (time: number, address: number, value: number) =>
    writes.push({ time, address, value });

  // Power-on housekeeping, before any note: every channel enabled, and both
  // sweep units given `$08` (disabled, negate). That is what drivers write and
  // why: at the power-on value of 0 the sweep's target overflows for every
  // period from `$400` up, which would mute the low pulse notes of a track that
  // never mentions `$4001`.
  put(0, 0x4015, enables(true));
  put(0, 0x4001, 0x08);
  put(0, 0x4005, 0x08);

  const voicesOf = (rows: readonly (PitchedRow | DrumRow)[], keep: (row: never) => boolean) =>
    rows
      .filter(keep as (row: PitchedRow | DrumRow) => boolean)
      .map((row) => ({
        start: lead + at(row[1]),
        end: lead + at(row[1] + row[2]),
        row,
      }))
      .filter((voice) => voice.end > voice.start)
      .sort((a, b) => a.start - b.start);

  // Pulses.
  for (const channel of [0, 1]) {
    const base = 0x4000 + channel * 4;
    const voices: Voice[] = voicesOf(
      input.pitched,
      // Period 0 would be a divide by zero on the chip too; a row with none is
      // a rest, not a note.
      ((row: PitchedRow) => row[3] === channel && row[5] >= 1) as (row: never) => boolean
    );
    voices.forEach((voice, i) => {
      const [, , , , volume, period, duty, volumeEnd, lengthTicks, bendIndex, envelope, sweep] =
        voice.row as PitchedRow;
      const bits = controlBits(envelope ?? -1, lengthTicks);
      const reg0 = (level: number) =>
        ((duty & 3) << 6) |
        (bits.halt ? 0x20 : 0) |
        (bits.constant ? 0x10 | (level & 0x0f) : bits.low);
      const level = (at: number) =>
        Math.min(15, Math.max(0, Math.round(volume + (volumeEnd - volume) * at)));

      put(voice.start, base, reg0(level(0)));
      put(voice.start, base + 1, sweep !== undefined && sweep >= 0 ? sweep : 0x08);
      put(voice.start, base + 2, period & 0xff);
      put(voice.start, base + 3, (bits.load << 3) | ((period >> 8) & 7));

      const curve = bendIndex >= 0 ? (bends[bendIndex] ?? null) : null;
      const ramps = bits.constant && volume !== volumeEnd;
      if (curve || ramps) {
        let lastLevel = level(0);
        let lastPeriod = period;
        for (const { time, position } of frames(voice.start, voice.end)) {
          if (ramps) {
            const now = level(position);
            if (now !== lastLevel) put(time, base, reg0(now));
            lastLevel = now;
          }
          if (curve) {
            // A semitone is a frequency ratio; the period is a divider, so it
            // moves the other way.
            const now = toPeriod((period + 1) * Math.pow(2, -bendAt(curve, position) / 12) - 1);
            if (now !== lastPeriod) {
              put(time, base + 2, now & 0xff);
              // The high byte only when it changes, as drivers do — writing it
              // restarts the sequencer, which is an audible click.
              if (now >> 8 !== lastPeriod >> 8) put(time, base + 3, (bits.load << 3) | (now >> 8));
            }
            lastPeriod = now;
          }
        }
      }

      const next = voices[i + 1];
      if (!next || next.start > voice.end + 1e-9) put(voice.end, base, ((duty & 3) << 6) | 0x30);
    });
  }

  // Triangle. No volume: it is ended by switching it off in `$4015`, the one
  // way to stop it on the spot — and it then holds whatever step it stopped on.
  {
    const voices: Voice[] = voicesOf(input.pitched, ((row: PitchedRow) =>
      row[3] === 2 && row[5] >= 1) as (row: never) => boolean);
    let on = true;
    voices.forEach((voice, i) => {
      const [, , , , , period, , , lengthTicks, bendIndex] = voice.row as PitchedRow;
      // With a counter to honour, the control bit is clear and the linear
      // counter set to its longest (127 quarter-frames, 0.53 s) so the length
      // counter is the one that ends the note; with none, the control bit set
      // halts both.
      const load = lengthTicks > 0 ? lengthIndex(lengthTicks) : 0;
      if (!on) put(voice.start, 0x4015, enables(true));
      on = true;
      put(voice.start, 0x4008, lengthTicks > 0 ? 0x7f : 0xff);
      put(voice.start, 0x400a, period & 0xff);
      put(voice.start, 0x400b, (load << 3) | ((period >> 8) & 7));

      const curve = bendIndex >= 0 ? (bends[bendIndex] ?? null) : null;
      if (curve) {
        let last = period;
        for (const { time, position } of frames(voice.start, voice.end)) {
          const now = toPeriod((period + 1) * Math.pow(2, -bendAt(curve, position) / 12) - 1);
          if (now !== last) {
            put(time, 0x400a, now & 0xff);
            if (now >> 8 !== last >> 8) put(time, 0x400b, (load << 3) | (now >> 8));
          }
          last = now;
        }
      }

      const next = voices[i + 1];
      if (!next || next.start > voice.end + 1e-9) {
        put(voice.end, 0x4015, enables(false));
        on = false;
      }
    });
  }

  // Noise.
  {
    const voices: Voice[] = voicesOf(input.drums, (() => true) as (row: never) => boolean);
    voices.forEach((voice, i) => {
      const [periodIndex, , , volume, volumeEnd, lengthTicks, envelope] = voice.row as DrumRow;
      const bits = controlBits(envelope ?? -1, lengthTicks);
      const reg = (level: number) =>
        (bits.halt ? 0x20 : 0) | (bits.constant ? 0x10 | (level & 0x0f) : bits.low);
      const level = (at: number) =>
        Math.min(15, Math.max(0, Math.round(volume + (volumeEnd - volume) * at)));

      put(voice.start, 0x400c, reg(level(0)));
      put(voice.start, 0x400e, periodIndex & 0x0f);
      put(voice.start, 0x400f, bits.load << 3);

      if (bits.constant && volume !== volumeEnd) {
        let last = level(0);
        for (const { time, position } of frames(voice.start, voice.end)) {
          const now = level(position);
          if (now !== last) put(time, 0x400c, reg(now));
          last = now;
        }
      }

      const next = voices[i + 1];
      if (!next || next.start > voice.end + 1e-9) put(voice.end, 0x400c, 0x30);
    });
  }

  return writes;
}

/** Render a decoded piece: `notesToWrites` into `renderWrites`, with the tick-based extras. */
export function renderNotes(input: ApuInput, options: ApuOptions = {}): ApuRender {
  const lead = options.lead ?? 0;

  const clicks: Click[] = [];
  if (options.metronome && options.metronome > 0) {
    for (let tick = 0, beat = 0; tick < input.totalTicks; tick += options.metronome, beat++) {
      // Four beats to a bar: the downbeat is what makes a tempo readable.
      clicks.push({ time: lead + tickToSeconds(input, tick), strong: beat % 4 === 0 });
    }
  }

  const { lead: _lead, metronome: _metronome, ...render } = options;
  const end = tickToSeconds(input, input.totalTicks);
  const result = renderWrites(notesToWrites(input, lead), lead + end, {
    ...render,
    clicks,
  });

  return {
    samples: result.samples,
    sampleRate: result.sampleRate,
    lead,
    duration: result.duration,
    loopStart: lead + tickToSeconds(input, Math.min(input.loopStart ?? 0, input.totalTicks)),
    loopEnd: lead + end,
    peak: result.peak,
  };
}
