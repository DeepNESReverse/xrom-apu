/**
 * The pulse channels' sweep unit (`$4001`/`$4005`), as pure functions.
 *
 * The chip uses these per half-frame; `sweepTrace` runs the same unit over one
 * note so a chart of an effect's pitch can show the period the chip PLAYS rather
 * than the one the data holds — for a swept sound those are not the same line.
 */

/** Rate the sweep unit and the length counters are clocked at — the half-frame. */
export const SWEEP_HZ = 120;

/**
 * `$4001` taken apart: `EPPP NSSS`.
 *
 * `pulse1` is not in the register — it is which channel it belongs to — but it
 * belongs here because the subtraction differs between the two channels by one,
 * and that one is audible as most of a semitone at short periods.
 */
export interface SweepConfig {
  enabled: boolean;
  /** Reload value for the divider: the unit acts every `dividerPeriod + 1` half-frames. */
  dividerPeriod: number;
  negate: boolean;
  shift: number;
  pulse1: boolean;
}

export function decodeSweep(value: number, pulse1: boolean): SweepConfig {
  return {
    enabled: (value & 0x80) !== 0,
    dividerPeriod: (value >> 4) & 7,
    negate: (value & 0x08) !== 0,
    shift: value & 7,
    pulse1,
  };
}

/**
 * The period the sweep unit would move to.
 *
 * Pulse 1 subtracts one MORE than pulse 2 — a hardware asymmetry, not a typo:
 * pulse 1 negates with one's complement and pulse 2 with two's.
 */
export function sweepTarget(period: number, sweep: SweepConfig): number {
  const change = period >> sweep.shift;
  if (!sweep.negate) return period + change;
  return period - change - (sweep.pulse1 ? 1 : 0);
}

/**
 * Is the channel silenced by the sweep unit?
 *
 * Two conditions, and both hold **whether or not the unit is enabled**: a
 * period below 8, and a target above `$7FF`. That second one surprises people —
 * with `$4001` at its power-on value of 0 (shift 0, add) every period from
 * `$400` up targets past `$7FF`, so a low pulse note is mute until something
 * writes the register. Drivers write `$08` (negate) for exactly this reason.
 */
export function sweepMutes(period: number, sweep: SweepConfig): boolean {
  if (period < 8) return true;
  return sweepTarget(period, sweep) > 0x7ff;
}

/**
 * The period the sweep unit holds at each half-frame of one note.
 *
 * `null` in the returned array is a half-frame where the unit mutes the channel.
 *
 * @param sweep the `$4001` byte; -1 or undefined gives a flat trace
 * @param channel 0 pulse 1, 1 pulse 2; anything else has no sweep unit
 */
export function sweepTrace(
  period: number,
  sweep: number | undefined,
  channel: number,
  halfFrames: number
): (number | null)[] {
  const config =
    channel < 2 && sweep !== undefined && sweep >= 0 ? decodeSweep(sweep, channel === 0) : null;
  const out: (number | null)[] = [];
  if (!config || period < 1) {
    for (let i = 0; i < halfFrames; i++) out.push(period < 1 ? null : period);
    return out;
  }

  let current = period;
  let divider = config.dividerPeriod;
  let reload = true;
  for (let i = 0; i < halfFrames; i++) {
    out.push(sweepMutes(current, config) ? null : current);
    if (divider === 0 && config.enabled && config.shift > 0 && !sweepMutes(current, config)) {
      current = Math.max(0, sweepTarget(current, config));
    }
    if (divider === 0 || reload) {
      divider = config.dividerPeriod;
      reload = false;
    } else {
      divider -= 1;
    }
  }
  return out;
}
