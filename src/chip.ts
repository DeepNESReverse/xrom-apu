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
 * It runs at a fixed sample rate rather than per CPU cycle: each call to
 * `levels()` advances the chip by one sample's worth of time and reports the
 * four channels' output levels (0..15) at that moment. The mixer and the
 * analogue stage are separate (`mixer.ts`), because a caller that wants to
 * hear one channel alone has to get at the levels before they are mixed.
 *
 * Not modelled: the DMC (`$4010`–`$4013` are accepted and ignored), the frame
 * IRQ, and the handful of cycle-exact write/clock races. Periods and levels are
 * the hardware's; timing is exact to the sample.
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

export interface ApuChipOptions {
  /**
   * Honour the length counters. Default true — it is hardware, and without it
   * a drum hit written with a short counter runs on as a wash. Off exists to
   * hear the difference.
   */
  lengthCounter?: boolean;
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

  /** Frame counter: 5-step mode, which step is next, samples until it. */
  private fiveStep = false;
  private frameStep = 0;
  private frameCountdown: number;
  private readonly samplesPerQuarterFrame: number;

  private readonly out = [0, 0, 0, 0];

  constructor(sampleRate: number, options: ApuChipOptions = {}) {
    this.sampleRate = sampleRate;
    this.lengthCounter = options.lengthCounter !== false;
    this.samplesPerQuarterFrame = sampleRate / QUARTER_FRAME_HZ;
    this.frameCountdown = this.samplesPerQuarterFrame;
    for (const p of this.pulses) this.retunePulse(p);
    this.retuneTriangle();
    this.retuneNoise();
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
      case 0x4015: {
        // Clearing a channel's bit empties its length counter at once — the
        // one way to silence a channel on the spot rather than at the next clock.
        const channels = [this.pulses[0], this.pulses[1], this.triangle, this.noise];
        channels.forEach((channel, i) => {
          channel.enabled = (v & (1 << i)) !== 0;
          if (!channel.enabled) channel.length = 0;
        });
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
  private readonly one = [new Uint8Array(1), new Uint8Array(1), new Uint8Array(1), new Float64Array(1)] as const;

  /**
   * Advance one sample and return the four channel levels, `[pulse1, pulse2,
   * triangle, noise]`, each 0..15 (noise can be fractional: see `fill`). The
   * array is reused between calls. For more than a sample at a time, `render`
   * is several times faster and gives the same numbers.
   */
  levels(): readonly number[] {
    const [a, b, c, d] = this.one;
    this.render(1, a, b, c, d, 0);
    const out = this.out;
    out[0] = a[0];
    out[1] = b[0];
    out[2] = c[0];
    out[3] = d[0];
    return out;
  }

  /**
   * Advance `count` samples, writing each channel's level into its buffer from
   * `offset` on. The pulses and the triangle are whole numbers 0..15, hence the
   * byte arrays; the noise is fractional (its gate is averaged over the shifts
   * in a sample). No register writes happen inside — a caller with writes due
   * splits the run at them.
   *
   * The frame counter is the only thing that changes a channel's parameters
   * between writes, so the run is cut at its clocks and each piece is filled a
   * channel at a time (`fill`). Every sum is the one `levels()` would do, in the
   * same order — the buffers come out bit for bit the same as `count` calls.
   */
  render(
    count: number,
    pulse1: Uint8Array,
    pulse2: Uint8Array,
    triangle: Uint8Array,
    noise: Float64Array,
    offset = 0
  ) {
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
        this.fill(1, pulse1, pulse2, triangle, noise, offset + done);
        done += 1;
      } else {
        const run = Math.min(free, count - done);
        this.frameCountdown -= run;
        this.fill(run, pulse1, pulse2, triangle, noise, offset + done);
        done += run;
      }
    }
  }

  /** `count` samples with every channel's parameters fixed — tight loops on locals. */
  private fill(
    count: number,
    pulse1: Uint8Array,
    pulse2: Uint8Array,
    triangle: Uint8Array,
    noise: Float64Array,
    at: number
  ) {
    const end = at + count;

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
