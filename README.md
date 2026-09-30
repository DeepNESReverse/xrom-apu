# @xromdev/apu

[![npm](https://img.shields.io/npm/v/@xromdev/apu)](https://www.npmjs.com/package/@xromdev/apu) [![test](https://github.com/DeepNESReverse/xrom-apu/actions/workflows/test.yml/badge.svg)](https://github.com/DeepNESReverse/xrom-apu/actions/workflows/test.yml) ![size](https://img.shields.io/bundlephobia/minzip/@xromdev/apu)

The NES sound chip — the 2A03's APU — in TypeScript. **Register writes in, samples out.**

Every NES game's music reaches the speaker the same way: a sound driver in the
cartridge writes to the registers `$4000`–`$4017`, sixty times a second. This
library is those registers. Give it the writes and it gives you back the sound,
whatever game they came from.

It was written to play Battletoads note for note from its decoded cartridge,
and is the synth for the music chapters of [xrom.dev](https://xrom.dev) as
they come out.

- No dependencies, ~5 KB gzipped, runs anywhere JavaScript does (browser, worker, Node).
- Pure and deterministic: the same writes always give the same samples, so it
  can be tested by measuring rather than by ear.
- Hardware-faithful where it is audible: the real duty sequences, the noise
  shift register, the length and linear counters, envelopes, the sweep unit
  (including the mute rules that catch people out), the non-linear mixer, and
  the console's output filters.

## Install

```sh
npm install @xromdev/apu
```

## Two ways in

### Register writes

What a driver writes, with a time in seconds:

```ts
import { renderWrites } from '@xromdev/apu';

const { samples, sampleRate } = renderWrites(
  [
    { time: 0, address: 0x4015, value: 0x01 }, // enable pulse 1
    { time: 0, address: 0x4000, value: 0xbf }, // duty 50%, constant volume 15
    { time: 0, address: 0x4001, value: 0x08 }, // sweep off (see below)
    { time: 0, address: 0x4002, value: 0xfd }, // period low byte
    { time: 0, address: 0x4003, value: 0x00 }, // period high bits: 253 → 440 Hz
    { time: 1, address: 0x4015, value: 0x00 }, // stop after a second
  ],
  1 // seconds
);
// samples: Float32Array, -1..1, mono, 44.1 kHz by default
```

This is the layer to use with an emulator trace, or with a driver you are
running yourself — any game, decoded or not.

### Notes

If the music is already decoded into notes, `renderNotes` plays the driver's
part — it writes what a driver would have written to sound them, and renders
that:

```ts
import { renderNotes, type PitchedRow } from '@xromdev/apu';

// [midi, startTick, ticks, channel, volume, period, duty, volumeEnd, lengthTicks, bendIndex]
const melody: PitchedRow[] = [
  [69, 0, 4, 0, 12, 253, 2, 12, 0, -1],
  [72, 4, 4, 0, 12, 212, 2, 4, 0, -1], // fades from 12 to 4 across the note
];

const render = renderNotes({ pitched: melody, drums: [], secondsPerTick: 0.1, totalTicks: 8 });
```

`notesToWrites` gives you the writes on their own, if you want to see them.

### Live

`Apu` is the chip on its own, for a live source such as a running emulator.
Write to it as the CPU does, and pull a block of samples whenever the audio
side wants one:

```ts
import { Apu, mixApu, OutputFilters } from '@xromdev/apu';

const rate = 48000;
const chip = new Apu(rate);
const filters = new OutputFilters(rate, false);
const p1 = new Uint8Array(128), p2 = new Uint8Array(128), tri = new Uint8Array(128);
const noise = new Float64Array(128);

chip.write(0x4015, 0x01); // …whenever the CPU writes

function nextBlock(out: Float32Array) {
  chip.render(out.length, p1, p2, tri, noise);
  for (let i = 0; i < out.length; i++) out[i] = filters.step(mixApu(p1[i], p2[i], tri[i], noise[i]));
}
```

`chip.levels()` does the same one sample at a time; `render` gives identical
numbers several times faster.

## Playing it in a browser

```ts
const context = new AudioContext();
const buffer = context.createBuffer(1, samples.length, sampleRate);
buffer.copyToChannel(samples, 0);
const source = context.createBufferSource();
source.buffer = buffer;
source.connect(context.destination);
source.start();
```

Rendering takes about 0.2 s for 100 s of music (see below); for long pieces,
do it in a Worker so the page never stalls.

## Size and speed

- **~12 KB minified, ~5 KB gzipped**, no dependencies.
- **About 500× faster than real time** at the default 2× oversampling: all 20
  Battletoads tracks — 16 minutes of music, 110 000 register writes — render in
  under 2 s on a laptop; the longest, 108 s, in 0.2 s (0.11 s without
  oversampling). The output buffer is 176 KB per second of sound.

How: anything that only changes when a register is written — each channel's
step per sample, whether the sweep unit mutes it — is worked out at the write,
not every sample; the chip fills runs of samples a channel at a time between
events; the noise register's whole 32 767-state cycle is a table, so N shifts
are one lookup; the mixer's common cases are tables built with its own formula;
the filters allocate nothing per sample. None of it changes a sample: the
test suite checks the fast paths against the plain ones bit for bit.

## Options

`renderWrites(writes, seconds, options)` and `renderNotes(input, options)` take:

| option | default | |
|---|---|---|
| `sampleRate` | 44100 | |
| `oversample` | 2 | Run the chip at 2× and average down. Square waves alias badly at 44.1 kHz without it. |
| `gain` | 2.2 | Master level. |
| `voiceLevels` | `[1,1,1,1]` | A fader per channel, applied before the mixer. Not on the console — the triangle has no volume at all — but it is how you hear one voice alone. |
| `filters` | true | The console's analogue stage. Off gives the raw mixer. |
| `consoleBass` | false | Add the console's 440 Hz high-pass. Real, but it takes 18 dB off a bass line at 82 Hz; on a television that was the sound, in headphones it is just thin. |
| `lengthCounter` | true | Off to hear what the length counters are doing. |

`renderNotes` also takes `lead` (seconds of silence first) and `metronome`
(a click every N ticks, mixed after the filters so it never sounds like the chip).

## Things the hardware does that you might not expect

- **`$4001` at its power-on value mutes low notes.** The sweep unit computes a
  target period whether or not it is enabled, and at shift 0 in add mode that
  target is double the period — past `$7FF` for every period from `$400` up,
  which silences the channel. Drivers write `$08` for this reason, and so should you.
- **Writing `$4003`/`$4007` restarts the note.** It reloads the length counter,
  restarts the envelope and resets the duty sequencer. A vibrato that rewrites
  the high byte every frame clicks on the console too.
- **The triangle never rests at zero.** When it is stopped it holds whatever
  step it was on, and its level still counts in the mixer — a triangle held
  high takes level from the noise channel beside it.
- **Pulse 1 and pulse 2 sweep differently by one.** Pulse 1 negates with one's
  complement, pulse 2 with two's.

## Not modelled

- **The DMC** (`$4010`–`$4013`, sampled sound). Writes to it are ignored.
- The frame IRQ, and the handful of races between a write and a clock landing
  on the same CPU cycle.
- PAL timings. Everything is NTSC.

## Development

```sh
npm install
npm test        # vitest
npm run build   # dist/
```

The tests measure the output — frequencies by counting zero crossings, silence
by peak level — rather than comparing against recordings, so each one states a
fact about the hardware in a form that can fail.

## License

MIT © Oleksandr Maksymov
