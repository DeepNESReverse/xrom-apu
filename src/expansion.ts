/**
 * The two expansion sound chips the Famicom's own games carried most: the Disk
 * System's wavetable voice (FDS) and Namco's 163 (N163). Each is a channel the
 * 2A03 does not have — a waveform drawn in RAM, played back at a pitch — and
 * games that use them put their melody there, so without them a soundtrack is
 * its bass and drums.
 *
 * Like the APU here they run at the sample rate, not per CPU cycle: each sample
 * advances the chip by `CPU_HZ / sampleRate` cycles' worth of its counters.
 *
 * Output is in the units `mixApu` returns (0..~1 for the whole 2A03), so a
 * renderer adds it to the mix. The levels relative to the 2A03 follow the
 * common reference players: FDS at full gain about as loud as both pulses at
 * full, an N163 channel at full volume about as loud as one pulse — divided by
 * the number of channels it time-shares its one output with, as the chip does.
 */

import { CPU_HZ } from './constants.js';

/** Full-scale output of the FDS (wave 63 × gain 32 at master volume 1), in `mixApu` units. */
const FDS_FULL = 0.25;
/** Full-scale output of one N163 sample step (|sample - 8| = 8 at volume 15), in `mixApu` units. */
const N163_FULL = 0.16;
/** The FDS master volume, `$4089` bits 0–1: 1, 2/3, 1/2, 2/5. */
const FDS_MASTER = [1, 2 / 3, 1 / 2, 2 / 5];
/** Mod table entries → how far each moves the mod counter; 4 resets it. */
const MOD_STEP = [0, 1, 2, 4, 0, -4, -2, -1];

export interface FdsSnapshot {
  /** 12-bit wave frequency; Hz = CPU_HZ * frequency / 4194304. */
  frequency: number;
  /** Volume gain as the chip uses it, 0..32. */
  gain: number;
  /** `$4089` bits 0–1. */
  master: number;
  /** The 64 wave samples, 0..63. */
  wave: number[];
  /** Wave unit halted (`$4083` bit 7) or the wave being written (`$4089` bit 7). */
  halted: boolean;
  /** Modulation depth (mod gain, 0..63) and frequency: a vibrato when both are above 0. */
  modGain: number;
  modFrequency: number;
}

export class FdsChip {
  private readonly cyclesPerSample: number;
  readonly wave = new Uint8Array(64);
  private readonly modTable = new Uint8Array(64);
  private modWritePos = 0;
  private frequency = 0;
  private haltWave = true;
  private envelopesOff = true;
  private waveWrite = false;
  private master = 0;
  private envSpeed = 0xe8;
  // Volume envelope.
  private volDirect = true;
  private volIncrease = false;
  private volSpeed = 0;
  private volGain = 0;
  private volCounter = 0;
  // Mod envelope and unit.
  private modDirect = true;
  private modIncrease = false;
  private modSpeed = 0;
  private modGain = 0;
  private modCounterEnv = 0;
  private modFrequency = 0;
  private modHalt = true;
  private modCounter = 0;
  private modPos = 0;
  private modAcc = 0;
  private waveAcc = 0;
  private wavePos = 0;
  /** Gain latched at the start of each wave cycle, as the chip does: a level change waits for the cycle. */
  private latchedGain = 0;

  constructor(sampleRate: number) {
    this.cyclesPerSample = CPU_HZ / sampleRate;
  }

  /** A write to `$4040`–`$408A`. Returns false for any other address. */
  write(address: number, value: number): boolean {
    const v = value & 0xff;
    if (address >= 0x4040 && address <= 0x407f) {
      if (this.waveWrite) this.wave[address - 0x4040] = v & 0x3f;
      return true;
    }
    switch (address) {
      case 0x4080:
        this.volDirect = (v & 0x80) !== 0;
        this.volIncrease = (v & 0x40) !== 0;
        this.volSpeed = v & 0x3f;
        if (this.volDirect) this.volGain = v & 0x3f;
        this.volCounter = 0;
        return true;
      case 0x4082:
        this.frequency = (this.frequency & 0xf00) | v;
        return true;
      case 0x4083:
        this.frequency = (this.frequency & 0x0ff) | ((v & 0x0f) << 8);
        this.haltWave = (v & 0x80) !== 0;
        this.envelopesOff = (v & 0x40) !== 0;
        if (this.haltWave) {
          this.waveAcc = 0;
          this.wavePos = 0;
        }
        return true;
      case 0x4084:
        this.modDirect = (v & 0x80) !== 0;
        this.modIncrease = (v & 0x40) !== 0;
        this.modSpeed = v & 0x3f;
        if (this.modDirect) this.modGain = v & 0x3f;
        this.modCounterEnv = 0;
        return true;
      case 0x4085:
        this.modCounter = ((v & 0x7f) << 25) >> 25; // 7-bit signed
        return true;
      case 0x4086:
        this.modFrequency = (this.modFrequency & 0xf00) | v;
        return true;
      case 0x4087:
        this.modFrequency = (this.modFrequency & 0x0ff) | ((v & 0x0f) << 8);
        this.modHalt = (v & 0x80) !== 0;
        if (this.modHalt) this.modAcc = 0;
        return true;
      case 0x4088:
        // Only while the mod unit is halted; each write fills two steps.
        if (this.modHalt) {
          this.modTable[this.modWritePos] = v & 7;
          this.modTable[(this.modWritePos + 1) & 63] = v & 7;
          this.modWritePos = (this.modWritePos + 2) & 63;
        }
        return true;
      case 0x4089:
        this.waveWrite = (v & 0x80) !== 0;
        this.master = v & 3;
        return true;
      case 0x408a:
        this.envSpeed = v;
        return true;
    }
    return address >= 0x4040 && address <= 0x4097;
  }

  /** The pitch the wave unit runs at this moment, after modulation (the chip's own arithmetic). */
  private modulatedFrequency(): number {
    if (this.modHalt || this.modGain === 0) return this.frequency;
    let temp = this.modCounter * this.modGain;
    const rem = temp & 0x0f;
    temp >>= 4;
    if (rem > 0 && (temp & 0x80) === 0) temp += this.modCounter < 0 ? -1 : 2;
    if (temp >= 192) temp -= 256;
    else if (temp < -64) temp += 256;
    temp *= this.frequency;
    const rem2 = temp & 0x3f;
    temp >>= 6;
    if (rem2 >= 32) temp += 1;
    return Math.max(0, this.frequency + temp);
  }

  /**
   * Advance `count` samples, ADDING the output to `out` from `offset` (in `mixApu` units, centred
   * by the renderer's filters like the rest).
   */
  render(count: number, out: Float64Array, offset = 0) {
    const cps = this.cyclesPerSample;
    const masterScale = (FDS_MASTER[this.master] * FDS_FULL) / (63 * 32);
    for (let k = 0; k < count; k++) {
      // Envelopes: one step every 8 × envSpeed × (speed + 1) cycles.
      if (!this.envelopesOff && this.envSpeed > 0 && !this.haltWave) {
        if (!this.volDirect) {
          this.volCounter += cps;
          const period = 8 * this.envSpeed * (this.volSpeed + 1);
          while (this.volCounter >= period) {
            this.volCounter -= period;
            if (this.volIncrease) {
              if (this.volGain < 32) this.volGain++;
            } else if (this.volGain > 0) this.volGain--;
          }
        }
        if (!this.modDirect) {
          this.modCounterEnv += cps;
          const period = 8 * this.envSpeed * (this.modSpeed + 1);
          while (this.modCounterEnv >= period) {
            this.modCounterEnv -= period;
            if (this.modIncrease) {
              if (this.modGain < 32) this.modGain++;
            } else if (this.modGain > 0) this.modGain--;
          }
        }
      }
      // Mod unit: steps through its table as its accumulator overflows 16 bits.
      if (!this.modHalt && this.modFrequency > 0) {
        this.modAcc += this.modFrequency * cps;
        while (this.modAcc >= 0x10000) {
          this.modAcc -= 0x10000;
          const step = this.modTable[this.modPos];
          this.modPos = (this.modPos + 1) & 63;
          if (step === 4) this.modCounter = 0;
          else {
            this.modCounter += MOD_STEP[step];
            if (this.modCounter > 63) this.modCounter -= 128;
            else if (this.modCounter < -64) this.modCounter += 128;
          }
        }
      }
      // Wave unit: 64 steps a cycle, the accumulator 16 bits a step.
      if (!this.haltWave && !this.waveWrite) {
        this.waveAcc += this.modulatedFrequency() * cps;
        while (this.waveAcc >= 0x10000) {
          this.waveAcc -= 0x10000;
          this.wavePos = (this.wavePos + 1) & 63;
          if (this.wavePos === 0) this.latchedGain = Math.min(32, this.volGain);
        }
        if (this.latchedGain === 0 && this.volGain > 0 && this.wavePos === 0) this.latchedGain = Math.min(32, this.volGain);
      }
      const level = this.waveWrite ? 0 : this.wave[this.wavePos] * this.latchedGain;
      out[offset + k] += level * masterScale;
    }
  }

  snapshot(): FdsSnapshot {
    return {
      frequency: this.frequency,
      gain: Math.min(32, this.volGain),
      master: this.master,
      wave: Array.from(this.wave),
      halted: this.haltWave || this.waveWrite,
      modGain: this.modHalt ? 0 : this.modGain,
      modFrequency: this.modHalt ? 0 : this.modFrequency,
    };
  }
}

export interface N163ChannelSnapshot {
  /** 0..7 — the register slot, `$40 + 8·slot` in the chip's RAM; slot 7 ($78) is always on. */
  slot: number;
  /** 18-bit frequency; Hz = CPU_HZ * frequency / (15 · 65536 · channels · length). */
  frequency: number;
  /** Wave length in 4-bit samples. */
  length: number;
  /** Where the wave starts, in 4-bit samples. */
  waveAddress: number;
  volume: number;
  /** The wave as it stands in RAM, `length` samples 0..15. */
  wave: number[];
}

export interface N163Snapshot {
  /** How many channels are on, 1..8 — the top ones, from slot 7 down. */
  channels: number;
  active: N163ChannelSnapshot[];
}

export class N163Chip {
  private readonly cyclesPerSample: number;
  readonly ram = new Uint8Array(128);
  private address = 0;
  private autoIncrement = false;
  private disabled = false;
  private readonly phase = new Float64Array(8);

  constructor(sampleRate: number) {
    this.cyclesPerSample = CPU_HZ / sampleRate;
  }

  /** A write to the address port (`$F800`), data port (`$4800`) or `$E000`. Returns false for others. */
  write(address: number, value: number): boolean {
    const v = value & 0xff;
    if (address >= 0xf800 && address <= 0xffff) {
      this.address = v & 0x7f;
      this.autoIncrement = (v & 0x80) !== 0;
      return true;
    }
    if (address >= 0x4800 && address <= 0x4fff) {
      this.ram[this.address] = v;
      if (this.autoIncrement) this.address = (this.address + 1) & 0x7f;
      return true;
    }
    if (address >= 0xe000 && address <= 0xe7ff) {
      this.disabled = (v & 0x40) !== 0;
      return true;
    }
    return false;
  }

  /** A read of the data port, as the CPU makes it — auto-increment included. */
  read(): number {
    const v = this.ram[this.address];
    if (this.autoIncrement) this.address = (this.address + 1) & 0x7f;
    return v;
  }

  get channels(): number {
    return ((this.ram[0x7f] >> 4) & 7) + 1;
  }

  /**
   * A channel's eight bytes: frequency low, middle, and high two bits with the wave length above
   * them; three bytes of phase; the wave's address; the volume. (Read off what Namco's own drivers
   * write — Erika to Satoru and Mappy Kids both put `$E0`/`$F0`, a 32- or 16-sample wave, in the
   * third byte.)
   */
  private channel(slot: number) {
    const base = 0x40 + slot * 8;
    const r = this.ram;
    return {
      frequency: r[base] | (r[base + 1] << 8) | ((r[base + 2] & 3) << 16),
      length: 256 - (r[base + 2] & 0xfc),
      waveAddress: r[base + 6],
      volume: r[base + 7] & 0x0f,
    };
  }

  private sample(index: number): number {
    const byte = this.ram[(index >> 1) & 0x7f];
    return index & 1 ? byte >> 4 : byte & 0x0f;
  }

  /**
   * Advance `count` samples, ADDING each active channel's output to `outs[slot]` (or, when a
   * channel has no buffer of its own, to `outs[8]` if given) from `offset`.
   */
  render(count: number, outs: readonly (Float64Array | undefined)[], offset = 0) {
    if (this.disabled) return;
    const n = this.channels;
    // Each channel is updated once every 15·n cycles, and the one DAC is shared n ways.
    const updatesPerSample = this.cyclesPerSample / (15 * n);
    const scale = N163_FULL / (8 * 15 * n);
    for (let slot = 8 - n; slot < 8; slot++) {
      const out = outs[slot] ?? outs[8];
      if (!out) continue;
      const c = this.channel(slot);
      if (c.volume === 0 || c.frequency === 0) continue;
      const step = c.frequency * updatesPerSample;
      const wrap = c.length * 0x10000;
      let phase = this.phase[slot];
      for (let k = 0; k < count; k++) {
        phase += step;
        if (phase >= wrap) phase %= wrap;
        const s = this.sample(((phase / 0x10000) | 0) + c.waveAddress);
        out[offset + k] += (s - 8) * c.volume * scale;
      }
      this.phase[slot] = phase;
    }
  }

  snapshot(): N163Snapshot {
    const n = this.channels;
    const active: N163ChannelSnapshot[] = [];
    for (let slot = 8 - n; slot < 8; slot++) {
      const c = this.channel(slot);
      const wave: number[] = [];
      for (let i = 0; i < Math.min(c.length, 256); i++) wave.push(this.sample(c.waveAddress + i));
      active.push({ slot, ...c, wave });
    }
    return { channels: this.disabled ? 0 : n, active: this.disabled ? [] : active };
  }
}

/** Hz of an FDS frequency register value. */
export const fdsHz = (frequency: number) => (CPU_HZ * frequency) / 4194304;

/** Hz of an N163 channel, from its frequency, wave length and the number of channels on. */
export const n163Hz = (frequency: number, length: number, channels: number) =>
  (CPU_HZ * frequency) / (15 * 65536 * channels * length);
