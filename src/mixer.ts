/**
 * The APU's mixer, from the hardware's own measured curves.
 *
 * Non-linear on purpose: two pulses at full volume are not twice one pulse, and
 * the triangle/noise group is louder per unit than the pulses. It also means
 * the channels are not independent — a triangle held high takes level from the
 * noise beside it. Getting this wrong is what makes a naive NES synth sound thin
 * and shrill.
 *
 * Inputs are each channel's output level — 0..15, and 0..127 for the DMC; the
 * result is 0..~1 and never negative. With the DMC at 0 its term adds exactly
 * nothing, so a mix without it is bit for bit the four-channel one. Centring it on zero is the output filters' job.
 */
export function mixApu(
  pulse1: number,
  pulse2: number,
  triangle: number,
  noise: number,
  dmc = 0
): number {
  const pulseSum = pulse1 + pulse2;
  const pulseOut = pulseSum === 0 ? 0 : 95.88 / (8128 / pulseSum + 100);
  const tnd = triangle / 8227 + noise / 12241 + dmc / 22638;
  const tndOut = tnd === 0 ? 0 : 159.79 / (1 / tnd + 100);
  return pulseOut + tndOut;
}

/**
 * `mixApu`'s two halves for whole-number inputs, precomputed with the same
 * expressions — so a lookup gives exactly the float the formula would.
 *
 * The pulses are always whole numbers (0..30 summed) unless a fader scales them;
 * the triangle is a whole step, and the noise is only fractional while it
 * sounds (its gate is averaged over the shifts in a sample). The renderer uses
 * these for the common cases and the formula for the rest.
 */
export const PULSE_MIX = Float64Array.from({ length: 31 }, (_, sum) =>
  sum === 0 ? 0 : 95.88 / (8128 / sum + 100)
);

/** Triangle alone, noise silent: `triangle / 8227 + 0 / 12241` through the curve. */
export const TRIANGLE_MIX = Float64Array.from({ length: 16 }, (_, level) => {
  const tnd = level / 8227 + 0 / 12241;
  return tnd === 0 ? 0 : 159.79 / (1 / tnd + 100);
});

/**
 * The analogue stage after the mixer, as the console has it.
 *
 * Two RC high-passes (90 Hz and 440 Hz) and a low-pass at 14 kHz, one pole each.
 * The 90 Hz one is what centres the signal on zero — without it every note
 * starts and ends on a step in the DC level, and each drum hit arrives as a
 * click the size of the sound itself.
 *
 * **The 440 Hz high-pass is off unless asked for.** It is real, but it costs
 * 18 dB at 82 Hz, which is where a triangle bass line lives: on a 1980s
 * television that loss was part of the sound, in headphones it just sounds
 * thin. `consoleBass` puts it back.
 */
export class OutputFilters {
  // Previous input and output of each stage, as plain numbers: this runs once
  // per sample, and a fresh object per sample is garbage by the megabyte.
  private hp90X = 0;
  private hp90Y = 0;
  private hp440X = 0;
  private hp440Y = 0;
  private lowPrev = 0;
  private readonly hp90: number;
  private readonly hp440: number;
  private readonly low: number;
  private readonly consoleBass: boolean;

  constructor(rate: number, consoleBass: boolean) {
    this.consoleBass = consoleBass;
    const highPass = (hz: number) => {
      const rc = 1 / (2 * Math.PI * hz);
      return rc / (rc + 1 / rate);
    };
    const lowPass = (hz: number) => {
      const rc = 1 / (2 * Math.PI * hz);
      return 1 / rate / (rc + 1 / rate);
    };
    this.hp90 = highPass(90);
    this.hp440 = highPass(440);
    this.low = lowPass(14000);
  }

  step(input: number): number {
    const a = this.hp90 * (this.hp90Y + input - this.hp90X);
    this.hp90X = input;
    this.hp90Y = a;

    let b = a;
    if (this.consoleBass) {
      b = this.hp440 * (this.hp440Y + a - this.hp440X);
      this.hp440X = a;
      this.hp440Y = b;
    }

    this.lowPrev += this.low * (b - this.lowPrev);
    return this.lowPrev;
  }
}
