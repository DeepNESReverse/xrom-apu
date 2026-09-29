/**
 * @xrom/apu — the NES sound chip (2A03 APU) in TypeScript.
 *
 * Two layers, usable separately:
 *
 *  - **The chip.** `renderWrites(writes, seconds)` plays a list of register
 *    writes — `{ time, address: 0x4000..0x4017, value }` — and returns samples.
 *    Every NES game's music reaches the speaker as writes like these, so this
 *    plays any game's music once its writes are known (from an emulator trace,
 *    say). `Apu` is the same chip one sample at a time, for live use.
 *  - **The note adapter.** `renderNotes(input)` takes music already decoded into
 *    notes and writes what a driver would have written to sound them.
 */

export {
  CPU_HZ,
  DUTY_SEQUENCES,
  FRAME_HZ,
  LENGTH_TABLE,
  NOISE_PERIODS,
  QUARTER_FRAME_HZ,
  TRIANGLE_STEPS,
} from './constants.js';
export { Apu, type ApuChipOptions } from './chip.js';
export { mixApu, OutputFilters } from './mixer.js';
export {
  SWEEP_HZ,
  decodeSweep,
  sweepMutes,
  sweepTarget,
  sweepTrace,
  type SweepConfig,
} from './sweep.js';
export {
  renderWrites,
  type Click,
  type RegisterWrite,
  type Render,
  type RenderOptions,
} from './render.js';
export {
  bendAt,
  notesToWrites,
  renderNotes,
  type ApuInput,
  type ApuOptions,
  type ApuRender,
  type BendCurve,
  type DrumRow,
  type PitchedRow,
} from './notes.js';
