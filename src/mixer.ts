/**
 * The APU's mixer, from the hardware's own measured curves.
 *
 * Non-linear on purpose: two pulses at full volume are not twice one pulse, and
 * the triangle/noise group is louder per unit than the pulses. It also means
 * the channels are not independent — a triangle held high takes level from the
 * noise beside it. Getting this wrong is what makes a naive NES synth sound thin
 * and shrill.
 *
 * Inputs are each channel's 4-bit output level (0..15); the result is 0..~1 and
 * never negative. Centring it on zero is the output filters' job.
 */
export function mixApu(pulse1: number, pulse2: number, triangle: number, noise: number): number {
  const pulseSum = pulse1 + pulse2;
  const pulseOut = pulseSum === 0 ? 0 : 95.88 / (8128 / pulseSum + 100);
  const tnd = triangle / 8227 + noise / 12241;
  const tndOut = tnd === 0 ? 0 : 159.79 / (1 / tnd + 100);
  return pulseOut + tndOut;
}

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
  private hp90Prev = { x: 0, y: 0 };
  private hp440Prev = { x: 0, y: 0 };
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
    const a = this.hp90 * (this.hp90Prev.y + input - this.hp90Prev.x);
    this.hp90Prev = { x: input, y: a };

    let b = a;
    if (this.consoleBass) {
      b = this.hp440 * (this.hp440Prev.y + a - this.hp440Prev.x);
      this.hp440Prev = { x: a, y: b };
    }

    this.lowPrev += this.low * (b - this.lowPrev);
    return this.lowPrev;
  }
}
