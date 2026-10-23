/**
 * The expansion sound chips the Famicom's own games carried most: the Disk
 * System's wavetable voice (FDS), Namco's 163 (N163) and Konami's VRC6. Each
 * adds channels the 2A03 does not have — a waveform drawn in RAM played back at
 * a pitch, or two more pulses and a sawtooth — and games that use them put
 * their melody there, so without them a soundtrack is its bass and drums.
 *
 * Like the APU here they run at the sample rate, not per CPU cycle: each sample
 * advances the chip by `CPU_HZ / sampleRate` cycles' worth of its counters.
 *
 * Output is in the units `mixApu` returns (0..~1 for the whole 2A03), so a
 * renderer adds it to the mix. The levels relative to the 2A03 follow the
 * common reference players: FDS at full gain about as loud as both pulses at
 * full, an N163 channel at full volume about as loud as one pulse — divided by
 * the number of channels it time-shares its one output with, as the chip does —
 * and a VRC6 pulse at full volume one and a half times a 2A03 pulse, as Mesen2
 * mixes it (`VRC6_STEP`).
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
/**
 * One step of the VRC6's output (pulse 0..15 + pulse 0..15 + saw 0..31), in `mixApu` units. From
 * Mesen2, which adds the chip's summed output × 15 (Core/NES/Mappers/Audio/Vrc6Audio.h) × 5
 * (Core/NES/NesSoundMixer.cpp, GetOutputVolume) to a 2A03 mix whose `mixApu` 1.0 is 5000 there:
 * 75 / 5000. A VRC6 pulse at volume 15 is so 0.225, about one and a half 2A03 pulses at 15.
 */
const VRC6_STEP = 75 / 5000;

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

  /** The address port as it stands — the next RAM byte the data port reaches, with bit 7 for auto-increment. */
  get port(): number {
    return this.address | (this.autoIncrement ? 0x80 : 0);
  }

  get channels(): number {
    return ((this.ram[0x7f] >> 4) & 7) + 1;
  }

  /**
   * A channel's eight bytes, interleaved as on the chip: frequency low, phase low, frequency
   * middle, phase middle, the frequency's high two bits with the wave length above them, phase
   * high, the wave's address, the volume. (Namco's drivers write the frequency bytes and step over
   * the phase ones by READING the data port — auto-increment counts reads too.)
   */
  private channel(slot: number) {
    const base = 0x40 + slot * 8;
    const r = this.ram;
    return {
      frequency: r[base] | (r[base + 2] << 8) | ((r[base + 4] & 3) << 16),
      length: 256 - (r[base + 4] & 0xfc),
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

/** One of the VRC6's two pulses, `$9000`–`$9002` or `$A000`–`$A002`. */
export interface Vrc6PulseSnapshot {
  /** 12-bit period; Hz = CPU_HZ / (16 · (period + 1)) — see `vrc6PulseHz`. */
  period: number;
  volume: number;
  /** 0..7: high for duty + 1 of every 16 steps. */
  duty: number;
  /** The mode bit (`$x000` bit 7): the volume put out as it is, the duty ignored. */
  constant: boolean;
  enabled: boolean;
}

export interface Vrc6Snapshot {
  pulse: [Vrc6PulseSnapshot, Vrc6PulseSnapshot];
  saw: {
    /** 12-bit period; Hz = CPU_HZ / (14 · (period + 1)) — see `vrc6SawHz`. */
    period: number;
    /** The accumulator rate, 0..63; past 42 the 8-bit accumulator wraps and the wave breaks up. */
    rate: number;
    enabled: boolean;
  };
  /** `$9003` bit 0: every oscillator stopped where it is. */
  halted: boolean;
  /** `$9003`: the periods shifted right by 4 (bit 1) or 8 (bit 2, which wins) — ×16 / ×256 pitch. */
  shift: number;
}

interface Vrc6Pulse {
  volume: number;
  duty: number;
  constant: boolean;
  period: number;
  enabled: boolean;
  /** CPU cycles until the next step, fractional. */
  timer: number;
  step: number;
}

/**
 * Konami's VRC6: two pulses with eight duties and a sawtooth, beside the 2A03 (Akumajou Densetsu,
 * Madara, Esper Dream 2). The registers are at the addresses the NSF format gives them —
 * `$9000`–`$9003`, `$A000`–`$A002`, `$B000`–`$B002`; the cartridges themselves differ in which of
 * A0/A1 they wire to the chip, which a player maps before here.
 *
 * Each channel counts down `(period >> shift) + 1` CPU cycles a step, as Mesen2's Vrc6Pulse/Vrc6Saw
 * do. Output is the average over each sample of what the chip puts out, so a high note at a low
 * sample rate keeps its level.
 */
export class Vrc6Chip {
  private readonly cyclesPerSample: number;
  private readonly pulses: [Vrc6Pulse, Vrc6Pulse] = [Vrc6Chip.newPulse(), Vrc6Chip.newPulse()];
  private sawRate = 0;
  private sawPeriod = 0;
  private sawEnabled = false;
  private sawTimer = 1;
  private sawStep = 0;
  private sawAccumulator = 0;
  private halted = false;
  private shift = 0;

  private static newPulse(): Vrc6Pulse {
    return { volume: 0, duty: 0, constant: false, period: 0, enabled: false, timer: 1, step: 0 };
  }

  constructor(sampleRate: number) {
    this.cyclesPerSample = CPU_HZ / sampleRate;
  }

  /** A write to `$9000`–`$9003`, `$A000`–`$A002` or `$B000`–`$B002`. Returns false for any other address. */
  write(address: number, value: number): boolean {
    const v = value & 0xff;
    if (address === 0x9003) {
      this.halted = (v & 1) !== 0;
      this.shift = v & 4 ? 8 : v & 2 ? 4 : 0;
      return true;
    }
    if ((address >= 0x9000 && address <= 0x9002) || (address >= 0xa000 && address <= 0xa002)) {
      const p = this.pulses[address >> 12 === 0x9 ? 0 : 1];
      switch (address & 3) {
        case 0:
          p.volume = v & 0x0f;
          p.duty = (v >> 4) & 7;
          p.constant = (v & 0x80) !== 0;
          break;
        case 1:
          p.period = (p.period & 0xf00) | v;
          break;
        case 2:
          p.period = (p.period & 0x0ff) | ((v & 0x0f) << 8);
          p.enabled = (v & 0x80) !== 0;
          // Clearing E resets the duty step; the divider runs on.
          if (!p.enabled) p.step = 0;
          break;
      }
      return true;
    }
    if (address >= 0xb000 && address <= 0xb002) {
      switch (address & 3) {
        case 0:
          this.sawRate = v & 0x3f;
          break;
        case 1:
          this.sawPeriod = (this.sawPeriod & 0xf00) | v;
          break;
        case 2:
          this.sawPeriod = (this.sawPeriod & 0x0ff) | ((v & 0x0f) << 8);
          this.sawEnabled = (v & 0x80) !== 0;
          if (!this.sawEnabled) {
            this.sawStep = 0;
            this.sawAccumulator = 0;
          }
          break;
      }
      return true;
    }
    return false;
  }

  private static pulseLevel(p: Vrc6Pulse): number {
    if (!p.enabled) return 0;
    if (p.constant) return p.volume;
    return p.step <= p.duty ? p.volume : 0;
  }

  /**
   * Advance `count` samples, ADDING each channel's output to `outs[0]` (pulse 1), `outs[1]` (pulse
   * 2) and `outs[2]` (saw) — or, for a channel without a buffer of its own, to `outs[3]` if given —
   * from `offset`.
   */
  render(count: number, outs: readonly (Float64Array | undefined)[], offset = 0) {
    const cps = this.cyclesPerSample;
    const scale = VRC6_STEP / cps;
    const running = !this.halted;
    for (let c = 0; c < 2; c++) {
      const out = outs[c] ?? outs[3];
      const p = this.pulses[c];
      const reload = (p.period >> this.shift) + 1;
      // Not stepping, or stepping makes no difference: one level for the whole run.
      if (!running || !p.enabled || p.constant || p.volume === 0) {
        if (out) {
          const level = Vrc6Chip.pulseLevel(p) * VRC6_STEP;
          if (level !== 0) for (let k = 0; k < count; k++) out[offset + k] += level;
        }
        if (running && p.enabled) {
          // The duty step moves on all the same, for when the level comes back.
          const cycles = count * cps;
          if (cycles >= p.timer) {
            const steps = 1 + Math.floor((cycles - p.timer) / reload);
            p.step = (p.step + steps) & 15;
            p.timer = reload - ((cycles - p.timer) % reload);
          } else p.timer -= cycles;
        }
        continue;
      }
      for (let k = 0; k < count; k++) {
        let left = cps;
        let sum = 0;
        while (left >= p.timer) {
          sum += (p.step <= p.duty ? p.volume : 0) * p.timer;
          left -= p.timer;
          p.step = (p.step + 1) & 15;
          p.timer = reload;
        }
        sum += (p.step <= p.duty ? p.volume : 0) * left;
        p.timer -= left;
        if (out) out[offset + k] += sum * scale;
      }
    }
    {
      const out = outs[2] ?? outs[3];
      const reload = (this.sawPeriod >> this.shift) + 1;
      if (!running || !this.sawEnabled) {
        const level = this.sawEnabled ? (this.sawAccumulator >> 3) * VRC6_STEP : 0;
        if (out && level !== 0) for (let k = 0; k < count; k++) out[offset + k] += level;
        return;
      }
      for (let k = 0; k < count; k++) {
        let left = cps;
        let sum = 0;
        while (left >= this.sawTimer) {
          sum += (this.sawAccumulator >> 3) * this.sawTimer;
          left -= this.sawTimer;
          this.sawTimer = reload;
          // Fourteen steps a cycle: the accumulator grows on every other one and starts over on the 14th.
          this.sawStep = (this.sawStep + 1) % 14;
          if (this.sawStep === 0) this.sawAccumulator = 0;
          else if ((this.sawStep & 1) === 0) this.sawAccumulator = (this.sawAccumulator + this.sawRate) & 0xff;
        }
        sum += (this.sawAccumulator >> 3) * left;
        this.sawTimer -= left;
        if (out) out[offset + k] += sum * scale;
      }
    }
  }

  snapshot(): Vrc6Snapshot {
    const pulse = (p: Vrc6Pulse): Vrc6PulseSnapshot => ({
      period: p.period,
      volume: p.volume,
      duty: p.duty,
      constant: p.constant,
      enabled: p.enabled,
    });
    return {
      pulse: [pulse(this.pulses[0]), pulse(this.pulses[1])],
      saw: { period: this.sawPeriod, rate: this.sawRate, enabled: this.sawEnabled },
      halted: this.halted,
      shift: this.shift,
    };
  }
}

/** Hz of an FDS frequency register value. */
export const fdsHz = (frequency: number) => (CPU_HZ * frequency) / 4194304;

/** Hz of an N163 channel, from its frequency, wave length and the number of channels on. */
export const n163Hz = (frequency: number, length: number, channels: number) =>
  (CPU_HZ * frequency) / (15 * 65536 * channels * length);

/** Hz of a VRC6 pulse period (with `$9003`'s shift, if any): 16 steps of `(period >> shift) + 1` cycles. */
export const vrc6PulseHz = (period: number, shift = 0) => CPU_HZ / (16 * ((period >> shift) + 1));

/** Hz of the VRC6 sawtooth's period (with `$9003`'s shift, if any): 14 steps of `(period >> shift) + 1` cycles. */
export const vrc6SawHz = (period: number, shift = 0) => CPU_HZ / (14 * ((period >> shift) + 1));
