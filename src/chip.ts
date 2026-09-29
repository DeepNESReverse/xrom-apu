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
 */

import {
  CPU_HZ,
  DUTY_SEQUENCES,
  LENGTH_TABLE,
  NOISE_PERIODS,
  QUARTER_FRAME_HZ,
  TRIANGLE_STEPS,
} from './constants.js';
import { decodeSweep, sweepMutes, sweepTarget, type SweepConfig } from './sweep.js';

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
  lfsr: number;
  /** Fractional timer position: how many register shifts are owed. */
  phase: number;
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
});

/** Envelope output: the written level, or the decay counter the chip runs itself. */
const envelopeLevel = (constant: boolean, volume: number, env: Envelope) =>
  constant ? volume : env.decay;

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
    phase: 0,
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
        return;
      }
      case 0x4002:
      case 0x4006: {
        const p = this.pulses[address === 0x4002 ? 0 : 1];
        p.period = (p.period & 0x700) | v;
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
        return;
      }
      case 0x4008:
        this.triangle.control = (v & 0x80) !== 0;
        this.triangle.linearReload = v & 0x7f;
        return;
      case 0x400a:
        this.triangle.period = (this.triangle.period & 0x700) | v;
        return;
      case 0x400b:
        // No phase reset here: the triangle's sequencer is never restarted, so
        // a new note picks up the staircase wherever the last one left it.
        this.triangle.period = (this.triangle.period & 0xff) | ((v & 7) << 8);
        if (this.triangle.enabled) this.triangle.length = LENGTH_TABLE[v >> 3];
        this.triangle.linearReloadFlag = true;
        return;
      case 0x400c:
        this.noise.halt = (v & 0x20) !== 0;
        this.noise.constant = (v & 0x10) !== 0;
        this.noise.volume = v & 0x0f;
        return;
      case 0x400e:
        this.noise.shortMode = (v & 0x80) !== 0;
        this.noise.periodIndex = v & 0x0f;
        return;
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

  /**
   * Advance one sample and return the four channel levels, `[pulse1, pulse2,
   * triangle, noise]`, each 0..15 (noise can be fractional: see below). The
   * array is reused between calls.
   */
  levels(): readonly number[] {
    this.frameCountdown -= 1;
    while (this.frameCountdown <= 0) {
      this.frameCountdown += this.samplesPerQuarterFrame;
      this.clockFrameCounter();
    }

    const rate = this.sampleRate;

    for (let i = 0; i < 2; i++) {
      const p = this.pulses[i];
      // A pulse steps through 8 entries per cycle and each entry takes
      // 2 × (period + 1) CPU cycles: CPU / (16 × (period + 1)) per cycle.
      p.phase += CPU_HZ / (2 * (p.period + 1)) / rate;
      if (p.phase >= 8) p.phase %= 8;
      const silent = p.length === 0 || sweepMutes(p.period, p.sweep);
      this.out[i] = silent
        ? 0
        : DUTY_SEQUENCES[p.duty][Math.floor(p.phase) & 7] *
          envelopeLevel(p.constant, p.volume, p.env);
    }

    const t = this.triangle;
    // The staircase only moves while both counters are non-zero. When either
    // runs out the sequencer STOPS where it is and the output holds that step:
    // the triangle is never "at zero" between notes, it is wherever it paused.
    if (t.length > 0 && t.linear > 0) {
      t.phase += CPU_HZ / (t.period + 1) / rate;
      if (t.phase >= 32) t.phase %= 32;
    }
    this.out[2] = TRIANGLE_STEPS[Math.floor(t.phase) & 31];

    const n = this.noise;
    n.phase += CPU_HZ / NOISE_PERIODS[n.periodIndex] / rate;
    const shifts = Math.floor(n.phase);
    n.phase -= shifts;
    // AVERAGE the register's output across the shifts this sample is worth,
    // rather than sampling wherever it lands. At the short periods the LFSR
    // runs well past the sample rate, and keeping only the last shift folds
    // the rest back as alias tones — drums like a broken speaker.
    let high = 0;
    const tap = n.shortMode ? 6 : 1;
    for (let i = 0; i < shifts; i++) {
      // The channel is silenced while bit 0 is set — the register gates it.
      if ((n.lfsr & 1) === 0) high++;
      const feedback = (n.lfsr & 1) ^ ((n.lfsr >> tap) & 1);
      n.lfsr = (n.lfsr >> 1) | (feedback << 14);
    }
    const gate = shifts > 0 ? high / shifts : (n.lfsr & 1) === 0 ? 1 : 0;
    this.out[3] = n.length === 0 ? 0 : gate * envelopeLevel(n.constant, n.volume, n.env);

    return this.out;
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
      if (
        p.sweepDivider === 0 &&
        p.sweep.enabled &&
        p.sweep.shift > 0 &&
        !sweepMutes(p.period, p.sweep)
      ) {
        p.period = Math.max(0, sweepTarget(p.period, p.sweep));
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
