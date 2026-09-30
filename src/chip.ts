/**
 * The 2A03's sound half, register by register.
 *
 * `Apu` holds what the chip holds — timers, sequencer positions, length and
 * linear counters, envelopes, sweep units, the frame counter — and changes it
 * only the ways the chip does: through a write to `$4000`–`$4017`, or through
 * its own clocks. Nothing here knows what a note is. That is the point: every
 * NES game's music, whatever its driver, reaches the speaker as writes to
 * these registers, so a synth that takes writes plays any of them.
 *
 * It runs at a fixed sample rate rather than per CPU cycle: `render()` advances
 * the chip a run of samples and reports each channel's output level — 0..15 for
 * the pulses, triangle and noise, 0..127 for the DMC — at every one of them. The
 * mixer and the analogue stage are separate (`mixer.ts`), because a caller that
 * wants to hear one channel alone has to get at the levels before they are mixed.
 *
 * The DMC reads its samples from the cartridge, `$8000`–`$FFFF`; give it that
 * memory as `options.memory` (without it, it reads zeros — a sample that only
 * ever steps down).
 *
 * Not modelled: the DMC's and the frame counter's IRQs, the CPU stall of the
 * DMC's memory reads, and the handful of cycle-exact write/clock races. Periods
 * and levels are the hardware's; timing is exact to the sample.
 *
 * **Speed.** `levels()` runs once per sample — 88 200 times a second of music at
 * the default oversampling — so anything that only changes when a register is
 * written (a channel's step per sample, whether the sweep unit mutes it) is
 * worked out at the write and kept, not recomputed here. The expressions are the
 * same ones, evaluated at a different moment, so the output is bit for bit what
 * recomputing them every sample gives.
 */

import {
  CPU_HZ,
  DMC_PERIODS,
  DUTY_SEQUENCES,
  LENGTH_TABLE,
  NOISE_PERIODS,
  QUARTER_FRAME_HZ,
  TRIANGLE_STEPS,
} from './constants.js';
import { LONG_CYCLE, LONG_HIGH_BEFORE, LONG_INDEX, LONG_STATES } from './lfsr.js';
import { decodeSweep, sweepMutes, sweepTarget, type SweepConfig } from './sweep.js';

/** The four duty sequences flattened, `duty * 8 + step`. */
const DUTY_FLAT = Uint8Array.from(DUTY_SEQUENCES.flat());
const TRIANGLE_FLAT = Uint8Array.from(TRIANGLE_STEPS);

interface Envelope {
  start: boolean;
  divider: number;
  decay: number;
}

interface Pulse {
  pulse1: boolean;
  duty: number;
  /** Bit 5 of `$4000`: halts the length counter AND loops the envelope — one bit, two jobs. */
  halt: boolean;
  constant: boolean;
  /** Bits 0..3 of `$4000`: the level when `constant`, the envelope's divider period when not. */
  volume: number;
  env: Envelope;
  sweep: SweepConfig;
  sweepDivider: number;
  sweepReload: boolean;
  /** The 11-bit timer period. */
  period: number;
  length: number;
  enabled: boolean;
  /** Position in the 8-step duty sequence, fractional. */
  phase: number;
  /** Steps of the sequence per sample, from `period` — kept, see "Speed". */
  step: number;
  /** Whether the sweep unit mutes the channel at this period — kept, see "Speed". */
  muted: boolean;
}

interface Triangle {
  /** Bit 7 of `$4008`: halts the length counter and keeps reloading the linear counter. */
  control: boolean;
  linearReload: number;
  linearReloadFlag: boolean;
  linear: number;
  period: number;
  length: number;
  enabled: boolean;
  phase: number;
  step: number;
}

interface Noise {
  halt: boolean;
  constant: boolean;
  volume: number;
  env: Envelope;
  /** Bit 7 of `$400E`: feedback from bit 6 instead of bit 1 — the short, metallic 93-step loop. */
  shortMode: boolean;
  periodIndex: number;
  length: number;
  enabled: boolean;
  /**
   * The register. In normal mode it is held as a position in the precomputed
   * cycle (`lfsrIndex`) and `lfsr` is stale; in short mode `lfsr` is the state.
   * A mode switch converts one into the other.
   */
  lfsr: number;
  lfsrIndex: number;
  /** Fractional timer position: how many register shifts are owed. */
  phase: number;
  step: number;
}

/**
 * What the chip is doing right now, channel by channel — for showing it, not
 * for driving it. Every field is a number the hardware itself holds.
 */
/**
 * The delta modulation channel: 1-bit samples read from cartridge memory, each
 * bit stepping a 7-bit output up or down by 2.
 */
interface Dmc {
  loop: boolean;
  rateIndex: number;
  /** Output level, 0..127. `$4011` sets it directly. */
  level: number;
  /** `$4012`/`$4013` as addresses and byte counts. */
  startAddress: number;
  startLength: number;
  /** The memory reader: where it reads next, and how many bytes are left. */
  address: number;
  remaining: number;
  /** The one-byte sample buffer, or -1 when empty. */
  buffer: number;
  /** The output unit: its shift register, bits left in it, and whether it is silent. */
  shift: number;
  bits: number;
  silence: boolean;
  phase: number;
  step: number;
}

/** Where every channel's output levels go, sample by sample. */
export interface ChannelBuffers {
  pulse1: Uint8Array;
  pulse2: Uint8Array;
  triangle: Uint8Array;
  /** Fractional: the gate is averaged over the shifts in a sample. */
  noise: Float64Array;
  dmc: Uint8Array;
}

/** Cartridge memory for the DMC: the bytes of `$8000`–`$FFFF`, or a reader for any address. */
export type ApuMemory = Uint8Array | ((address: number) => number);

export interface ApuSnapshot {
  pulse: {
    period: number;
    duty: number;
    /** Length counter, in half-frames; 0 is silent. */
    length: number;
    /** Level the channel outputs when high: the written volume, or the envelope's decay. */
    level: number;
    constant: boolean;
    /** The sweep unit is muting the channel (period < 8, or target past $7FF). */
    muted: boolean;
    enabled: boolean;
  }[];
  triangle: {
    period: number;
    length: number;
    /** Linear counter, in quarter-frames; 0 is silent. */
    linear: number;
    /** The step the staircase is on — held while silent. */
    step: number;
    enabled: boolean;
  };
  noise: {
    periodIndex: number;
    shortMode: boolean;
    length: number;
    level: number;
    constant: boolean;
    enabled: boolean;
  };
  dmc: {
    /** Output level, 0..127. */
    level: number;
    rateIndex: number;
    loop: boolean;
    /** Bytes of the sample still to read; above 0 means it is playing. */
    remaining: number;
    /** Where the memory reader is. */
    address: number;
    enabled: boolean;
  };
}

export interface ApuChipOptions {
  /**
   * Honour the length counters. Default true — it is hardware, and without it
   * a drum hit written with a short counter runs on as a wash. Off exists to
   * hear the difference.
   */
  lengthCounter?: boolean;
  /** Where the DMC reads its samples from — see `ApuMemory`. Reads 0 when absent. */
  memory?: ApuMemory;
}

const newEnvelope = (): Envelope => ({ start: false, divider: 0, decay: 0 });

const newPulse = (pulse1: boolean): Pulse => ({
  pulse1,
  duty: 0,
  halt: false,
  constant: false,
  volume: 0,
  env: newEnvelope(),
  sweep: decodeSweep(0, pulse1),
  sweepDivider: 0,
  sweepReload: false,
  period: 0,
  length: 0,
  enabled: false,
  phase: 0,
  step: 0,
  muted: true,
});

/** One quarter-frame of an envelope, in the hardware's order. */
function clockEnvelope(env: Envelope, period: number, loop: boolean) {
  if (env.start) {
    env.start = false;
    env.decay = 15;
    env.divider = period;
  } else if (env.divider === 0) {
    env.divider = period;
    if (env.decay > 0) env.decay -= 1;
    else if (loop) env.decay = 15;
  } else {
    env.divider -= 1;
  }
}

export class Apu {
  readonly sampleRate: number;
  private readonly lengthCounter: boolean;

  private readonly pulses: [Pulse, Pulse] = [newPulse(true), newPulse(false)];
  private readonly triangle: Triangle = {
    control: false,
    linearReload: 0,
    linearReloadFlag: false,
    linear: 0,
    period: 0,
    length: 0,
    enabled: false,
    // Start on a zero step, so a chip that has not been written to is silent
    // rather than holding the top of the staircase as DC. The triangle's
    // position only moves while it sounds, so this is where it rests until the
    // first note — the part of power-on a listener would otherwise hear as a
    // thump.
    phase: 16,
    step: 0,
  };
  private readonly noise: Noise = {
    halt: false,
    constant: false,
    volume: 0,
    env: newEnvelope(),
    shortMode: false,
    periodIndex: 0,
    length: 0,
    enabled: false,
    lfsr: 1, // the chip powers up with bit 0 set
    lfsrIndex: LONG_INDEX[1],
    phase: 0,
    step: 0,
  };

  private readonly dmc: Dmc = {
    loop: false,
    rateIndex: 0,
    level: 0,
    startAddress: 0xc000,
    startLength: 1,
    address: 0xc000,
    remaining: 0,
    buffer: -1,
    shift: 0,
    bits: 8,
    silence: true,
    phase: 0,
    step: 0,
  };
  private readonly read: (address: number) => number;

  /** Frame counter: 5-step mode, which step is next, samples until it. */
  private fiveStep = false;
  private frameStep = 0;
  private frameCountdown: number;
  private readonly samplesPerQuarterFrame: number;

  private readonly out = [0, 0, 0, 0, 0];

  constructor(sampleRate: number, options: ApuChipOptions = {}) {
    this.sampleRate = sampleRate;
    this.lengthCounter = options.lengthCounter !== false;
    this.samplesPerQuarterFrame = sampleRate / QUARTER_FRAME_HZ;
    this.frameCountdown = this.samplesPerQuarterFrame;
    for (const p of this.pulses) this.retunePulse(p);
    this.retuneTriangle();
    this.retuneNoise();
    this.retuneDmc();
    const memory = options.memory;
    this.read =
      typeof memory === 'function'
        ? (address) => memory(address) & 0xff
        : memory && memory.length > 0
          ? (address) => memory[(address - 0x8000) % memory.length]
          : () => 0;
  }

  /** A CPU write to one of the APU's registers. Anything outside `$4000`–`$4017` is ignored. */
  write(address: number, value: number) {
    const v = value & 0xff;
    switch (address) {
      case 0x4000:
      case 0x4004: {
        const p = this.pulses[address === 0x4000 ? 0 : 1];
        p.duty = v >> 6;
        p.halt = (v & 0x20) !== 0;
        p.constant = (v & 0x10) !== 0;
        p.volume = v & 0x0f;
        return;
      }
      case 0x4001:
      case 0x4005: {
        const p = this.pulses[address === 0x4001 ? 0 : 1];
        p.sweep = decodeSweep(v, p.pulse1);
        p.sweepReload = true;
        p.muted = sweepMutes(p.period, p.sweep);
        return;
      }
      case 0x4002:
      case 0x4006: {
        const p = this.pulses[address === 0x4002 ? 0 : 1];
        p.period = (p.period & 0x700) | v;
        this.retunePulse(p);
        return;
      }
      case 0x4003:
      case 0x4007: {
        // The high byte does three things at once, and all three are audible:
        // it reloads the length counter, restarts the envelope, and puts the
        // duty sequencer back to its first step — which is why a driver that
        // rewrites it every frame for a vibrato makes the vibrato click.
        const p = this.pulses[address === 0x4003 ? 0 : 1];
        p.period = (p.period & 0xff) | ((v & 7) << 8);
        if (p.enabled) p.length = LENGTH_TABLE[v >> 3];
        p.env.start = true;
        p.phase = 0;
        this.retunePulse(p);
        return;
      }
      case 0x4008:
        this.triangle.control = (v & 0x80) !== 0;
        this.triangle.linearReload = v & 0x7f;
        return;
      case 0x400a:
        this.triangle.period = (this.triangle.period & 0x700) | v;
        this.retuneTriangle();
        return;
      case 0x400b:
        // No phase reset here: the triangle's sequencer is never restarted, so
        // a new note picks up the staircase wherever the last one left it.
        this.triangle.period = (this.triangle.period & 0xff) | ((v & 7) << 8);
        if (this.triangle.enabled) this.triangle.length = LENGTH_TABLE[v >> 3];
        this.triangle.linearReloadFlag = true;
        this.retuneTriangle();
        return;
      case 0x400c:
        this.noise.halt = (v & 0x20) !== 0;
        this.noise.constant = (v & 0x10) !== 0;
        this.noise.volume = v & 0x0f;
        return;
      case 0x400e: {
        const n = this.noise;
        const shortMode = (v & 0x80) !== 0;
        // Hand the register between its two representations: a position in the
        // precomputed cycle for normal mode, the raw state for short mode.
        if (shortMode && !n.shortMode) n.lfsr = LONG_STATES[n.lfsrIndex];
        if (!shortMode && n.shortMode) n.lfsrIndex = LONG_INDEX[n.lfsr];
        n.shortMode = shortMode;
        n.periodIndex = v & 0x0f;
        this.retuneNoise();
        return;
      }
      case 0x400f:
        if (this.noise.enabled) this.noise.length = LENGTH_TABLE[v >> 3];
        this.noise.env.start = true;
        return;
      case 0x4010:
        this.dmc.loop = (v & 0x40) !== 0;
        this.dmc.rateIndex = v & 0x0f;
        this.retuneDmc();
        return;
      case 0x4011:
        // Straight to the output — the way games play PCM without the DMC's
        // own memory reader, one write per sample.
        this.dmc.level = v & 0x7f;
        return;
      case 0x4012:
        this.dmc.startAddress = 0xc000 + v * 64;
        return;
      case 0x4013:
        this.dmc.startLength = v * 16 + 1;
        return;
      case 0x4015: {
        // Clearing a channel's bit empties its length counter at once — the
        // one way to silence a channel on the spot rather than at the next clock.
        const channels = [this.pulses[0], this.pulses[1], this.triangle, this.noise];
        channels.forEach((channel, i) => {
          channel.enabled = (v & (1 << i)) !== 0;
          if (!channel.enabled) channel.length = 0;
        });
        // Bit 4 is the DMC's: clear stops the sample (what is already in the
        // buffer still plays out); set starts it again if it had finished.
        const d = this.dmc;
        if ((v & 0x10) === 0) d.remaining = 0;
        else if (d.remaining === 0) {
          d.address = d.startAddress;
          d.remaining = d.startLength;
          this.fetchDmc();
        }
        return;
      }
      case 0x4017:
        this.fiveStep = (v & 0x80) !== 0;
        this.frameStep = 0;
        this.frameCountdown = this.samplesPerQuarterFrame;
        // Selecting 5-step mode clocks everything once, immediately.
        if (this.fiveStep) {
          this.clockQuarterFrame();
          this.clockHalfFrame();
        }
        return;
      default:
        return;
    }
  }

  /** Scratch buffers for `levels()`, one sample long. */
  private readonly one: ChannelBuffers = {
    pulse1: new Uint8Array(1),
    pulse2: new Uint8Array(1),
    triangle: new Uint8Array(1),
    noise: new Float64Array(1),
    dmc: new Uint8Array(1),
  };

  /**
   * Advance one sample and return the five channel levels, `[pulse1, pulse2,
   * triangle, noise, dmc]` (see `render`). The array is reused between calls.
   * For more than a sample at a time, `render` is several times faster and
   * gives the same numbers.
   */
  levels(): readonly number[] {
    const one = this.one;
    this.render(1, one);
    const out = this.out;
    out[0] = one.pulse1[0];
    out[1] = one.pulse2[0];
    out[2] = one.triangle[0];
    out[3] = one.noise[0];
    out[4] = one.dmc[0];
    return out;
  }

  /**
   * Advance `count` samples, writing each channel's level into its buffer from
   * `offset` on: the pulses, triangle and DMC as whole numbers (0..15, 0..127),
   * the noise fractional (its gate is averaged over the shifts in a sample). No
   * register writes happen inside — a caller with writes due splits the run at
   * them.
   *
   * The frame counter is the only thing that changes a channel's parameters
   * between writes, so the run is cut at its clocks and each piece is filled a
   * channel at a time (`fill`). Every sum is the one `levels()` would do, in the
   * same order — the buffers come out bit for bit the same as `count` calls.
   */
  render(count: number, buffers: ChannelBuffers, offset = 0) {
    let done = 0;
    while (done < count) {
      // Samples before the one on which the counter reaches zero. Subtracting
      // them in one go is exact: the counter holds a value whose fractional
      // bits are all representable after taking off a whole number.
      const free = Math.ceil(this.frameCountdown) - 1;
      if (free <= 0) {
        this.frameCountdown -= 1;
        while (this.frameCountdown <= 0) {
          this.frameCountdown += this.samplesPerQuarterFrame;
          this.clockFrameCounter();
        }
        this.fill(1, buffers, offset + done);
        done += 1;
      } else {
        const run = Math.min(free, count - done);
        this.frameCountdown -= run;
        this.fill(run, buffers, offset + done);
        done += run;
      }
    }
  }

  /** `count` samples with every channel's parameters fixed — tight loops on locals. */
  private fill(count: number, buffers: ChannelBuffers, at: number) {
    const end = at + count;
    const { pulse1, pulse2, triangle, noise } = buffers;

    for (let i = 0; i < 2; i++) {
      const p = this.pulses[i];
      const out = i === 0 ? pulse1 : pulse2;
      // A pulse steps through 8 entries per cycle and each entry takes
      // 2 × (period + 1) CPU cycles: CPU / (16 × (period + 1)) per cycle.
      const step = p.step;
      let phase = p.phase;
      if (p.length === 0 || p.muted) {
        for (let k = at; k < end; k++) {
          phase += step;
          if (phase >= 8) phase %= 8;
          out[k] = 0;
        }
      } else {
        const level = p.constant ? p.volume : p.env.decay;
        const base = p.duty * 8;
        for (let k = at; k < end; k++) {
          phase += step;
          if (phase >= 8) phase %= 8;
          out[k] = DUTY_FLAT[base + ((phase | 0) & 7)] * level;
        }
      }
      p.phase = phase;
    }

    const t = this.triangle;
    // The staircase only moves while both counters are non-zero. When either
    // runs out the sequencer STOPS where it is and the output holds that step:
    // the triangle is never "at zero" between notes, it is wherever it paused.
    if (t.length > 0 && t.linear > 0) {
      const step = t.step;
      let phase = t.phase;
      for (let k = at; k < end; k++) {
        phase += step;
        if (phase >= 32) phase %= 32;
        triangle[k] = TRIANGLE_FLAT[(phase | 0) & 31];
      }
      t.phase = phase;
    } else {
      triangle.fill(TRIANGLE_FLAT[(t.phase | 0) & 31], at, end);
    }

    // AVERAGE the register's output across the shifts each sample is worth,
    // rather than sampling wherever it lands. At the short periods the LFSR
    // runs well past the sample rate, and keeping only the last shift folds the
    // rest back as alias tones — drums like a broken speaker. The channel is
    // silenced while bit 0 is set: the register gates it.
    const n = this.noise;
    const level = n.length === 0 ? 0 : n.constant ? n.volume : n.env.decay;
    const step = n.step;
    let phase = n.phase;
    if (!n.shortMode) {
      let index = n.lfsrIndex;
      if (level === 0) {
        // Silent, but the register keeps shifting: advance it, output nothing.
        for (let k = at; k < end; k++) {
          phase += step;
          const shifts = Math.floor(phase);
          phase -= shifts;
          if (shifts > 0) index = (index + shifts) % LONG_CYCLE;
        }
        noise.fill(0, at, end);
      } else {
        for (let k = at; k < end; k++) {
          phase += step;
          const shifts = Math.floor(phase);
          phase -= shifts;
          let gate: number;
          if (shifts > 0) {
            gate = (LONG_HIGH_BEFORE[index + shifts] - LONG_HIGH_BEFORE[index]) / shifts;
            index = (index + shifts) % LONG_CYCLE;
          } else {
            gate = (LONG_STATES[index] & 1) === 0 ? 1 : 0;
          }
          noise[k] = gate * level;
        }
      }
      n.lfsrIndex = index;
    } else {
      let lfsr = n.lfsr;
      for (let k = at; k < end; k++) {
        phase += step;
        const shifts = Math.floor(phase);
        phase -= shifts;
        let high = 0;
        for (let s = 0; s < shifts; s++) {
          if ((lfsr & 1) === 0) high++;
          const feedback = (lfsr & 1) ^ ((lfsr >> 6) & 1);
          lfsr = (lfsr >> 1) | (feedback << 14);
        }
        const gate = shifts > 0 ? high / shifts : (lfsr & 1) === 0 ? 1 : 0;
        noise[k] = level === 0 ? 0 : gate * level;
      }
      n.lfsr = lfsr;
    }
    n.phase = phase;

    this.fillDmc(buffers.dmc, at, end);
  }

  /**
   * The DMC over `[at, end)`. At most a bit or two per sample even at its
   * fastest rate, so it is clocked bit by bit; a channel with nothing to play
   * only has its output-cycle count moved on, which is all that changes.
   */
  private fillDmc(out: Uint8Array, at: number, end: number) {
    const d = this.dmc;
    if (d.silence && d.remaining === 0 && d.buffer < 0) {
      // Nothing to play: the output holds, and only the timer and the bit count
      // move on. Worked out for the whole run at once — nothing audible depends
      // on the timer's exact fraction until a sample starts, and starting one
      // takes a register write, which ends the run.
      const total = d.phase + d.step * (end - at);
      const clocks = Math.floor(total);
      d.phase = total - clocks;
      // Each clock uses up a bit; an emptied cycle starts another, silent,
      // since there is nothing to load.
      d.bits -= clocks % 8;
      if (d.bits <= 0) d.bits += 8;
      out.fill(d.level, at, end);
      return;
    }
    for (let k = at; k < end; k++) {
      d.phase += d.step;
      while (d.phase >= 1) {
        d.phase -= 1;
        this.clockDmc();
      }
      out[k] = d.level;
    }
  }

  /** One DMC timer clock: step the output by the next bit, and start a new byte after eight. */
  private clockDmc() {
    const d = this.dmc;
    if (!d.silence) {
      if (d.shift & 1) {
        if (d.level <= 125) d.level += 2;
      } else if (d.level >= 2) {
        d.level -= 2;
      }
    }
    d.shift >>= 1;
    d.bits -= 1;
    if (d.bits === 0) {
      d.bits = 8;
      if (d.buffer < 0) {
        d.silence = true;
      } else {
        d.silence = false;
        d.shift = d.buffer;
        d.buffer = -1;
        this.fetchDmc();
      }
    }
  }

  /** The memory reader: refill the empty buffer from the cartridge, looping or stopping at the end. */
  private fetchDmc() {
    const d = this.dmc;
    if (d.buffer >= 0 || d.remaining === 0) return;
    d.buffer = this.read(d.address);
    d.address = d.address === 0xffff ? 0x8000 : d.address + 1;
    d.remaining -= 1;
    if (d.remaining === 0 && d.loop) {
      d.address = d.startAddress;
      d.remaining = d.startLength;
    }
  }

  private retuneDmc() {
    this.dmc.step = CPU_HZ / DMC_PERIODS[this.dmc.rateIndex] / this.sampleRate;
  }

  /** A copy of the channels' internal counters and levels — see `ApuSnapshot`. */
  snapshot(): ApuSnapshot {
    const t = this.triangle;
    const n = this.noise;
    return {
      pulse: this.pulses.map((p) => ({
        period: p.period,
        duty: p.duty,
        length: p.length,
        level: p.constant ? p.volume : p.env.decay,
        constant: p.constant,
        muted: p.muted,
        enabled: p.enabled,
      })),
      triangle: {
        period: t.period,
        length: t.length,
        linear: t.linear,
        step: TRIANGLE_FLAT[(t.phase | 0) & 31],
        enabled: t.enabled,
      },
      noise: {
        periodIndex: n.periodIndex,
        shortMode: n.shortMode,
        length: n.length,
        level: n.constant ? n.volume : n.env.decay,
        constant: n.constant,
        enabled: n.enabled,
      },
      dmc: {
        level: this.dmc.level,
        rateIndex: this.dmc.rateIndex,
        loop: this.dmc.loop,
        remaining: this.dmc.remaining,
        address: this.dmc.address,
        enabled: this.dmc.remaining > 0,
      },
    };
  }

  private retunePulse(p: Pulse) {
    p.step = CPU_HZ / (2 * (p.period + 1)) / this.sampleRate;
    p.muted = sweepMutes(p.period, p.sweep);
  }

  private retuneTriangle() {
    this.triangle.step = CPU_HZ / (this.triangle.period + 1) / this.sampleRate;
  }

  private retuneNoise() {
    this.noise.step = CPU_HZ / NOISE_PERIODS[this.noise.periodIndex] / this.sampleRate;
  }

  private clockFrameCounter() {
    // 4-step: quarter frames on every step, half frames on steps 2 and 4.
    // 5-step: quarter frames on 1, 2, 3 and 5, half frames on 2 and 5.
    const step = this.frameStep;
    if (this.fiveStep) {
      this.frameStep = (step + 1) % 5;
      if (step !== 3) this.clockQuarterFrame();
      if (step === 1 || step === 4) this.clockHalfFrame();
    } else {
      this.frameStep = (step + 1) % 4;
      this.clockQuarterFrame();
      if (step === 1 || step === 3) this.clockHalfFrame();
    }
  }

  private clockQuarterFrame() {
    for (const p of this.pulses) clockEnvelope(p.env, p.volume, p.halt);
    clockEnvelope(this.noise.env, this.noise.volume, this.noise.halt);

    const t = this.triangle;
    if (t.linearReloadFlag) t.linear = t.linearReload;
    else if (t.linear > 0) t.linear -= 1;
    if (!t.control) t.linearReloadFlag = false;
  }

  private clockHalfFrame() {
    if (this.lengthCounter) {
      for (const p of this.pulses) if (!p.halt && p.length > 0) p.length -= 1;
      if (!this.triangle.control && this.triangle.length > 0) this.triangle.length -= 1;
      if (!this.noise.halt && this.noise.length > 0) this.noise.length -= 1;
    }

    for (const p of this.pulses) {
      // The hardware's order: adjust first, then reload or count down.
      if (p.sweepDivider === 0 && p.sweep.enabled && p.sweep.shift > 0 && !p.muted) {
        p.period = Math.max(0, sweepTarget(p.period, p.sweep));
        this.retunePulse(p);
      }
      if (p.sweepDivider === 0 || p.sweepReload) {
        p.sweepDivider = p.sweep.dividerPeriod;
        p.sweepReload = false;
      } else {
        p.sweepDivider -= 1;
      }
    }
  }
}
