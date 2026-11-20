/**
 * Konami's VRC7: six channels of two-operator FM, a cut-down Yamaha YM2413 (OPLL), beside the 2A03
 * — on one Famicom game, Lagrange Point, whose whole score is on it.
 *
 * A model of the chip from its documented behaviour, not a port of any emulator: each channel is a
 * modulator and a carrier, sine (or half-sine) operators with an ADSR envelope in decibels, the
 * modulator's self-feedback and the carrier's phase moved by the modulator. The fifteen built-in
 * instruments are the chip's ROM as dumped (NESdev wiki, "VRC7 audio"); instrument 0 is the one a
 * driver writes into `$00`–`$07`. It runs at the chip's own rate — 3.58 MHz / 72, 49716 Hz a
 * channel — and is resampled to the output rate linearly.
 *
 * Registers through the NSF format's two ports: `$9010` picks a register, `$9030` writes it.
 * `$E000` bit 6 holds the sound in reset (silent).
 */

/** The chip's update rate: its 3.579545 MHz clock over the 72 cycles it takes to update all channels. */
export const VRC7_RATE = 3579545 / 72;

/**
 * The built-in instruments 1..15, bytes `$00`–`$07` each (modulator, carrier): TVSK MMMM ×2,
 * KKOO OOOO, KK-Q WFFF, AAAA DDDD ×2, SSSS RRRR ×2.
 */
export const VRC7_INSTRUMENTS: readonly (readonly number[])[] = [
  [0x03, 0x21, 0x05, 0x06, 0xe8, 0x81, 0x42, 0x27], // 1 Buzzy Bell
  [0x13, 0x41, 0x14, 0x0d, 0xd8, 0xf6, 0x23, 0x12], // 2 Guitar
  [0x11, 0x11, 0x08, 0x08, 0xfa, 0xb2, 0x20, 0x12], // 3 Wurly
  [0x31, 0x61, 0x0c, 0x07, 0xa8, 0x64, 0x61, 0x27], // 4 Flute
  [0x32, 0x21, 0x1e, 0x06, 0xe1, 0x76, 0x01, 0x28], // 5 Clarinet
  [0x02, 0x01, 0x06, 0x00, 0xa3, 0xe2, 0xf4, 0xf4], // 6 Synth
  [0x21, 0x61, 0x1d, 0x07, 0x82, 0x81, 0x11, 0x07], // 7 Trumpet
  [0x23, 0x21, 0x22, 0x17, 0xa2, 0x72, 0x01, 0x17], // 8 Organ
  [0x35, 0x11, 0x25, 0x00, 0x40, 0x73, 0x72, 0x01], // 9 Bells
  [0xb5, 0x01, 0x0f, 0x0f, 0xa8, 0xa5, 0x51, 0x02], // A Vibes
  [0x17, 0xc1, 0x24, 0x07, 0xf8, 0xf8, 0x22, 0x12], // B Vibraphone
  [0x71, 0x23, 0x11, 0x06, 0x65, 0x74, 0x18, 0x16], // C Tutti
  [0x01, 0x02, 0xd3, 0x05, 0xc9, 0x95, 0x03, 0x02], // D Fretless
  [0x61, 0x63, 0x0c, 0x00, 0x94, 0xc0, 0x33, 0xf6], // E Synth Bass
  [0x21, 0x72, 0x0d, 0x00, 0xc1, 0xd5, 0x56, 0x06], // F Sweep
];

/** Hz of a channel's 9-bit frequency and 3-bit octave: 49716 · f / 2^(19 − octave). */
export const vrc7Hz = (fnum: number, block: number) => (VRC7_RATE * fnum) / Math.pow(2, 19 - block);

/**
 * Peak output of one channel at full level (carrier at 0 dB), in `mixApu` units: about as loud as
 * a 2A03 pulse at 15 swings, so the six channels sit in the mix as the reference players put them.
 */
const VRC7_FULL = 0.12;

/** The multiplier field: ×½, ×1 … ×15, with 10/12/15 doubled up as on the chip. */
const MULTIPLIER = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
/** Key level scaling at octave 7 by the frequency's top four bits, in dB, before the per-octave fall. */
const KSL_BASE = [0, 9, 12, 13.875, 15, 16.125, 16.875, 17.625, 18, 18.75, 19.125, 19.5, 19.875, 20.25, 20.625, 21];
/** The KSL field → the share of `KSL_BASE` taken: none, 1.5, 3 and 6 dB an octave. */
const KSL_SHIFT = [0, 0.5, 1, 2];
/** Below this attenuation the envelope is silent. */
const SILENT_DB = 48;
const SINE = Float64Array.from({ length: 1024 }, (_, i) => Math.sin((2 * Math.PI * i) / 1024));
/** Tremolo: 3.7 Hz, 4.8 dB deep. Vibrato: 6.4 Hz, ±14 cents. */
const AM_HZ = 3.7;
const AM_DB = 4.8;
const VIB_HZ = 6.4;
const VIB_CENTS = 14;
const VIB_DEPTH = (VIB_CENTS / 1200) * Math.LN2;

type Stage = 'attack' | 'decay' | 'sustain' | 'release' | 'off';

interface Operator {
  /** Phase in cycles, 0..1. */
  phase: number;
  stage: Stage;
  /** Envelope attenuation in dB, 0 (loudest) .. 48 (silent). */
  db: number;
  /** The last two outputs (the modulator's feedback), −1..1. */
  out1: number;
  out2: number;
}

interface Channel {
  fnum: number;
  block: number;
  key: boolean;
  sustain: boolean;
  instrument: number;
  /** 0 (loudest) .. 15, in 3 dB steps. */
  volume: number;
  mod: Operator;
  car: Operator;
  /** The channel's last two chip-rate outputs, for the resampler. */
  previous: number;
  current: number;
}

/** One VRC7 channel as a decoder reads it. */
export interface Vrc7ChannelSnapshot {
  fnum: number;
  block: number;
  /** Bit 4 of `$2x`: keyed on. */
  key: boolean;
  /** Bit 5 of `$2x`: the slow release after key-off. */
  sustain: boolean;
  /** 0 is the driver's own (`$00`–`$07`), 1..15 the chip's. */
  instrument: number;
  /** 0 (loudest) .. 15. */
  volume: number;
  /** The carrier still sounding (keyed, or in its release above the floor). */
  sounding: boolean;
}

export interface Vrc7Snapshot {
  channels: Vrc7ChannelSnapshot[];
  /** `$00`–`$07`: the instrument a driver writes itself. */
  custom: number[];
  /** `$E000` bit 6: the sound held in reset. */
  silenced: boolean;
}

const newOperator = (): Operator => ({ phase: 0, stage: 'off', db: SILENT_DB, out1: 0, out2: 0 });

/**
 * Per chip step, by effective rate 0..63: the share of `(dB + 3)` an attack takes off (silence to
 * full in 2.826 s at rate 4, the OPL's table, twice as fast every 4), and the dB a decay adds (96 dB
 * over 39.28 s at rate 4).
 */
const ATTACK_STEP = Float64Array.from({ length: 64 }, (_, rate) =>
  Math.log(17) / (2.826 * Math.pow(2, -(rate - 4) / 4)) / VRC7_RATE
);
const DECAY_STEP = Float64Array.from({ length: 64 }, (_, rate) => 96 / (39.28 * Math.pow(2, -(rate - 4) / 4)) / VRC7_RATE);
/** 10^(−dB/20) at 1/64 dB steps, 0..128 dB. */
const DB_STEPS = 64;
const AMPLITUDE = Float64Array.from({ length: 128 * DB_STEPS + 1 }, (_, i) => Math.pow(10, -i / DB_STEPS / 20));
const amplitudeOf = (db: number) => (db >= 128 ? 0 : AMPLITUDE[(db * DB_STEPS) | 0]);

export class Vrc7Chip {
  private readonly ratio: number;
  /** Chip-rate steps owed to the next output sample, fractional. */
  private clock = 0;
  private address = 0;
  private readonly registers = new Uint8Array(0x40);
  private readonly channels: Channel[] = Array.from({ length: 6 }, () => ({
    fnum: 0,
    block: 0,
    key: false,
    sustain: false,
    instrument: 0,
    volume: 0,
    mod: newOperator(),
    car: newOperator(),
    previous: 0,
    current: 0,
  }));
  private silenced = false;
  /** The tremolo's and vibrato's phases, in cycles. */
  private amPhase = 0;
  private vibPhase = 0;

  constructor(sampleRate: number) {
    this.ratio = VRC7_RATE / sampleRate;
  }

  /** A write to `$9010`, `$9030` or `$E000`. Returns false for any other address. */
  write(address: number, value: number): boolean {
    const v = value & 0xff;
    if (address === 0x9010) {
      this.address = v & 0x3f;
      return true;
    }
    if (address === 0x9030) {
      this.writeRegister(this.address, v);
      return true;
    }
    if (address === 0xe000) {
      this.silenced = (v & 0x40) !== 0;
      // Shared with the mapper's mirroring bits: not ours to claim.
      return false;
    }
    return false;
  }

  private writeRegister(register: number, v: number) {
    this.registers[register] = v;
    const k = register & 0x0f;
    if (k > 5) return;
    const c = this.channels[k];
    switch (register & 0xf0) {
      case 0x10:
        c.fnum = (c.fnum & 0x100) | v;
        break;
      case 0x20: {
        c.fnum = (c.fnum & 0xff) | ((v & 1) << 8);
        c.block = (v >> 1) & 7;
        c.sustain = (v & 0x20) !== 0;
        const key = (v & 0x10) !== 0;
        if (key && !c.key) this.keyOn(c);
        else if (!key && c.key) this.keyOff(c);
        c.key = key;
        break;
      }
      case 0x30:
        c.instrument = v >> 4;
        c.volume = v & 0x0f;
        break;
    }
  }

  private keyOn(c: Channel) {
    for (const op of [c.mod, c.car]) {
      op.phase = 0;
      op.stage = 'attack';
    }
    c.mod.out1 = c.mod.out2 = 0;
  }

  private keyOff(c: Channel) {
    for (const op of [c.mod, c.car]) if (op.stage !== 'off') op.stage = 'release';
  }

  /** The channel's instrument: the chip's, or `$00`–`$07` (the register file's first eight bytes). */
  private patchOf(c: Channel): ArrayLike<number> {
    return c.instrument === 0 ? this.registers : VRC7_INSTRUMENTS[c.instrument - 1];
  }

  /** The effective envelope rate (0..63) of a 4-bit rate field, with key rate scaling. */
  private static rate(field: number, c: Channel, ksr: boolean) {
    if (field === 0) return 0;
    const keyCode = (c.block << 1) | (c.fnum >> 8);
    return Math.min(63, field * 4 + (ksr ? keyCode : keyCode >> 2));
  }

  /** One chip-rate step of an operator's envelope. */
  private static envelope(op: Operator, c: Channel, flags: number, ad: number, sr: number, carrier: boolean) {
    const ksr = (flags & 0x10) !== 0;
    const sustained = (flags & 0x20) !== 0;
    switch (op.stage) {
      case 'attack': {
        const rate = Vrc7Chip.rate(ad >> 4, c, ksr);
        if (rate === 0) break;
        if (rate >= 60) op.db = 0;
        else op.db -= (op.db + 3) * ATTACK_STEP[rate];
        if (op.db <= 0.05) {
          op.db = 0;
          op.stage = 'decay';
        }
        break;
      }
      case 'decay': {
        const level = (sr >> 4) * 3;
        const rate = Vrc7Chip.rate(ad & 0x0f, c, ksr);
        if (rate) op.db += DECAY_STEP[rate];
        if (op.db >= level) {
          op.db = level;
          op.stage = 'sustain';
        }
        break;
      }
      case 'sustain':
        // A sustained voice holds; a percussive one goes on falling at its release rate.
        if (!sustained && sr & 0x0f) op.db += DECAY_STEP[Vrc7Chip.rate(sr & 0x0f, c, ksr)];
        break;
      case 'release': {
        // The modulator releases with the carrier; the sustain bit slows a released note to rate 5.
        const field = carrier && c.sustain ? 5 : sr & 0x0f;
        if (field) op.db += DECAY_STEP[Vrc7Chip.rate(field, c, ksr)];
        break;
      }
      case 'off':
        break;
    }
    if (op.db >= SILENT_DB) {
      op.db = SILENT_DB;
      if (op.stage !== 'attack') op.stage = op.stage === 'sustain' && sustained ? 'sustain' : 'off';
    }
  }

  /** One chip-rate output of channel `c`, −1..1. */
  private step(c: Channel, am: number, vib: number): number {
    const patch = this.patchOf(c);
    const mFlags = patch[0], cFlags = patch[1], mLevel = patch[2], cLevel = patch[3];
    const mAd = patch[4], cAd = patch[5], mSr = patch[6], cSr = patch[7];
    Vrc7Chip.envelope(c.mod, c, mFlags, mAd, mSr, false);
    Vrc7Chip.envelope(c.car, c, cFlags, cAd, cSr, true);
    const base = (c.fnum << c.block) / 524288;
    const kslDb = Math.max(0, KSL_BASE[c.fnum >> 5] - (7 - c.block) * 6);

    // Modulator: self-feedback of its last two outputs, 0, π/16 … 4π.
    const fb = cLevel & 7;
    const mod = c.mod;
    const mInc = base * MULTIPLIER[mFlags & 0x0f] * (mFlags & 0x40 ? vib : 1);
    mod.phase = (mod.phase + mInc) % 1;
    const mDb = mod.db + (mLevel & 0x3f) * 0.75 + kslDb * KSL_SHIFT[mLevel >> 6] + (mFlags & 0x80 ? am : 0);
    let mOut = 0;
    if (mod.stage !== 'off' && mDb < SILENT_DB + 30) {
      const feedback = fb ? (mod.out1 + mod.out2) * Math.pow(2, fb - 7) : 0;
      let s = SINE[(((mod.phase + feedback) * 1024) | 0) & 1023];
      if (cLevel & 0x08 && s < 0) s = 0;
      mOut = s * amplitudeOf(mDb);
    }
    mod.out2 = mod.out1;
    mod.out1 = mOut;

    // Carrier: its phase moved by the modulator's output, ±4π at full.
    const car = c.car;
    const cInc = base * MULTIPLIER[cFlags & 0x0f] * (cFlags & 0x40 ? vib : 1);
    car.phase = (car.phase + cInc) % 1;
    if (car.stage === 'off') return 0;
    const cDb = car.db + c.volume * 3 + kslDb * KSL_SHIFT[cLevel >> 6] + (cFlags & 0x80 ? am : 0);
    if (cDb >= SILENT_DB) return 0;
    let s = SINE[(((car.phase + mOut * 2) * 1024) | 0) & 1023];
    if (cLevel & 0x10 && s < 0) s = 0;
    return s * amplitudeOf(cDb);
  }

  /**
   * Advance `count` samples, ADDING each channel's output to `outs[0..5]` — or, for a channel
   * without a buffer of its own, to `outs[6]` if given — from `offset`.
   */
  render(count: number, outs: readonly (Float64Array | undefined)[], offset = 0) {
    for (let k = 0; k < count; k++) {
      this.clock += this.ratio;
      while (this.clock >= 1) {
        this.clock -= 1;
        this.amPhase = (this.amPhase + AM_HZ / VRC7_RATE) % 1;
        this.vibPhase = (this.vibPhase + VIB_HZ / VRC7_RATE) % 1;
        // Tremolo 0..AM_DB down; vibrato ±VIB_CENTS, near enough linear at that size.
        const am = AM_DB * 0.5 * (1 + SINE[(this.amPhase * 1024) | 0]);
        const vib = 1 + VIB_DEPTH * SINE[(this.vibPhase * 1024) | 0];
        for (const c of this.channels) {
          c.previous = c.current;
          c.current = this.silenced ? 0 : this.step(c, am, vib);
        }
      }
      // Between the chip's last two outputs, by how far the next one is.
      const t = this.clock;
      for (let ch = 0; ch < 6; ch++) {
        const out = outs[ch] ?? outs[6];
        if (!out) continue;
        const c = this.channels[ch];
        const value = c.previous + (c.current - c.previous) * t;
        if (value !== 0) out[offset + k] += value * VRC7_FULL;
      }
    }
  }

  snapshot(): Vrc7Snapshot {
    return {
      channels: this.channels.map((c) => ({
        fnum: c.fnum,
        block: c.block,
        key: c.key,
        sustain: c.sustain,
        instrument: c.instrument,
        volume: c.volume,
        sounding: c.car.stage !== 'off' && c.car.db < SILENT_DB,
      })),
      custom: Array.from(this.registers.subarray(0, 8)),
      silenced: this.silenced,
    };
  }
}
