# xrom-apu

The NES sound chip — the 2A03's APU — in TypeScript. **Register writes in, samples out.**

Every NES game's music reaches the speaker the same way: a sound driver in the
cartridge writes to the registers `$4000`–`$4017`, sixty times a second. This
library is those registers. Give it the writes and it gives you back the sound,
whatever game they came from.

It was written to play Battletoads note for note from its decoded cartridge,
and is the synth for the music chapters of [xrom.dev](https://xrom.dev) as
they come out.

- No dependencies, runs anywhere JavaScript does (browser, worker, Node).
- Pure and deterministic: the same writes always give the same samples, so it
  can be tested by measuring rather than by ear.
- Hardware-faithful where it is audible: the real duty sequences, the noise
  shift register, the length and linear counters, envelopes, the sweep unit
  (including the mute rules that catch people out), the non-linear mixer, and
  the console's output filters.

## Install

```sh
npm install github:DeepNESReverse/xrom-apu
```

## Two ways in

### Register writes

What a driver writes, with a time in seconds:

```ts
import { renderWrites } from 'xrom-apu';

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
import { renderNotes, type PitchedRow } from 'xrom-apu';

// [midi, startTick, ticks, channel, volume, period, duty, volumeEnd, lengthTicks, bendIndex]
const melody: PitchedRow[] = [
  [69, 0, 4, 0, 12, 253, 2, 12, 0, -1],
  [72, 4, 4, 0, 12, 212, 2, 4, 0, -1], // fades from 12 to 4 across the note
];

const render = renderNotes({ pitched: melody, drums: [], secondsPerTick: 0.1, totalTicks: 8 });
```

`notesToWrites` gives you the writes on their own, if you want to see them.

### Live

`Apu` is the chip one sample at a time, for a live source such as a running
emulator:

```ts
import { Apu, mixApu, OutputFilters } from 'xrom-apu';

const chip = new Apu(48000);
const filters = new OutputFilters(48000, false);

chip.write(0x4015, 0x01); // …whenever the CPU writes

function nextSample() {
  const [p1, p2, tri, noise] = chip.levels();
  return filters.step(mixApu(p1, p2, tri, noise));
}
```

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

A long piece takes a noticeable fraction of a second to render; do it in a
Worker to keep the page responsive.

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
