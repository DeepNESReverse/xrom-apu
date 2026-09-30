/**
 * The noise channel's shift register, precomputed.
 *
 * In its normal mode the 15-bit LFSR (feedback from bits 0 and 1) visits every
 * non-zero state once before repeating: a single cycle of 32767. So its whole
 * future is a table, and N shifts from any state are an index plus N — no loop.
 * That matters because at the shortest periods the register shifts several
 * times per output sample, every sample, whether or not the channel is audible.
 *
 * `LONG_HIGH_BEFORE[i]` counts, over the first `i` states of the cycle, those
 * with bit 0 clear — the states in which the channel is NOT gated off. The
 * table covers the cycle twice so a run of shifts can cross the seam without a
 * wrap check.
 *
 * Short mode (feedback from bits 0 and 6) splits the states into several short
 * loops instead of one, so it is stepped the plain way; it is rare in music.
 */

export const LONG_CYCLE = 32767;

/** State at each position of the cycle, starting from the power-on state 1. */
export const LONG_STATES = new Uint16Array(LONG_CYCLE);
/** Position of each state in the cycle. Index 0 (the dead all-zero state) is unused. */
export const LONG_INDEX = new Uint16Array(32768);
/** Prefix counts of "bit 0 clear" over the cycle, doubled; see above. */
export const LONG_HIGH_BEFORE = new Uint16Array(2 * LONG_CYCLE + 1);

{
  let state = 1;
  for (let i = 0; i < LONG_CYCLE; i++) {
    LONG_STATES[i] = state;
    LONG_INDEX[state] = i;
    const feedback = (state & 1) ^ ((state >> 1) & 1);
    state = (state >> 1) | (feedback << 14);
  }
  for (let i = 0; i < 2 * LONG_CYCLE; i++) {
    LONG_HIGH_BEFORE[i + 1] = LONG_HIGH_BEFORE[i] + ((LONG_STATES[i % LONG_CYCLE] & 1) === 0 ? 1 : 0);
  }
}
