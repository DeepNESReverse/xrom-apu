/**
 * Numbers that are the hardware's, not ours.
 *
 * NTSC throughout: the PAL console divides a different crystal and has its own
 * noise and DMC tables. Everything here is quoted from how the 2A03 is wired,
 * so a value that looks tunable is not.
 */

/** 21477272 / 12 — the NTSC CPU clock the APU divides down. */
export const CPU_HZ = 1789772.7272727273;

/**
 * Quarter-frame rate of the frame counter, NTSC: one step every 7457.5 CPU
 * cycles. Envelopes and the triangle's linear counter run at this rate; length
 * counters and sweeps at half of it.
 */
export const QUARTER_FRAME_HZ = CPU_HZ / 7457.5;

/** `$400E` low nibble → noise timer period in CPU cycles, NTSC. */
export const NOISE_PERIODS = [
  4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
] as const;

/**
 * The top five bits of `$4003`/`$4007`/`$400B`/`$400F` → length counter load,
 * in half-frames. Not monotonic, and not meant to be: it interleaves two series
 * so that one index can hold both a note length and a rest.
 */
export const LENGTH_TABLE = [
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22,
  192, 24, 72, 26, 16, 28, 32, 30,
] as const;

/**
 * The pulse duty cycles as the hardware holds them: an 8-step sequence each.
 *
 * 75% is the inversion of 25%, not a fifth shape — which is why duty 1 and
 * duty 3 sound the same on a speaker: a waveform and its inverse differ only in
 * phase. Kept as the real bit patterns so the shape is the chip's.
 */
export const DUTY_SEQUENCES = [
  [0, 1, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 0, 0, 0],
  [1, 0, 0, 1, 1, 1, 1, 1],
] as const;

/** The triangle's 32 steps: down 15→0, then back up 0→15. */
export const TRIANGLE_STEPS: readonly number[] = Array.from({ length: 32 }, (_, i) =>
  i < 16 ? 15 - i : i - 16
);

/**
 * NTSC video frame rate — 29780.5 CPU cycles a frame. A sound driver runs once
 * per frame (from the NMI), so this is the rate at which music reaches the
 * registers, and the rate the note adapter updates a ramp or a bend at.
 */
export const FRAME_HZ = CPU_HZ / 29780.5;

/**
 * `$4010` low nibble → DMC timer period in CPU cycles, NTSC: one delta bit per
 * period, so 4.2 kHz at the slowest to 33.1 kHz at the fastest.
 */
export const DMC_PERIODS = [
  428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54,
] as const;
