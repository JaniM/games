import type { Cue } from "./cues";

// The sounds, made with the Web Audio API instead of played from files: there is nothing to
// download, and each one is a few lines. Wood on wood is a few short resonances with a click
// on top (see `knock`); the jingles at the end are plain notes.
//
// A page may only make sound once the person has used it, and a browser that is asked
// earlier complains in the console. So the audio context is made late: when the page has
// been used, or on the first press or key (see `unlockOnGesture`). Until it runs, a cue is
// dropped rather than kept, as a sound that comes late is worse than none.

/** The gain at full volume. The loudest sound adds up to a little over 1 before it, so this keeps it from clipping. */
const MAX_GAIN = 0.6;
const NOISE_SECONDS = 1;
/** What a gain ramps down to: an exponential ramp cannot reach 0. */
const SILENT = 0.0001;

interface Rig {
  ctx: AudioContext;
  /** Everything plays through this, which sets the volume. */
  out: GainNode;
  /** White noise to cut the ticks from. */
  noise: AudioBuffer;
}

let rig: Rig | null = null;
let unavailable = false;
/** The listeners of `unlockOnGesture` are in place, or have done their work. */
let armed = false;

function createRig(): Rig | null {
  const Context =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  try {
    const ctx = new Context();
    const out = ctx.createGain();
    out.gain.value = MAX_GAIN;
    out.connect(ctx.destination);
    const noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return { ctx, out, noise };
  } catch {
    return null;
  }
}

/** Whether the browser has seen the person use the page (it is true if it cannot tell). */
function pageWasUsed(): boolean {
  return globalThis.navigator?.userActivation?.hasBeenActive ?? true;
}

/** The audio, made on first need. `gesture` says this is inside a press or key. */
function getRig(gesture: boolean): Rig | null {
  if (rig || unavailable) return rig;
  if (!gesture && !pageWasUsed()) return null;
  rig = createRig();
  unavailable = rig === null;
  return rig;
}

/**
 * Makes the audio the first time the page is pressed or a key is typed, and keeps trying
 * until it runs (Safari wants the call inside the gesture). Safe to call again.
 */
export function unlockOnGesture(): void {
  if (armed || typeof window === "undefined") return;
  armed = true;
  const events = ["pointerdown", "keydown"] as const;
  const stop = () => {
    for (const event of events) window.removeEventListener(event, unlock);
  };
  const unlock = () => {
    const made = getRig(true);
    if (!made) return stop();
    if (made.ctx.state === "running") return stop();
    made.ctx.resume().then(
      () => made.ctx.state === "running" && stop(),
      () => {},
    );
  };
  for (const event of events) window.addEventListener(event, unlock);
}

// --- Building blocks ---

/**
 * A burst of noise over a wide band, a few thousandths of a second long: the click of the
 * moment two hard things meet. (A narrow band, or a long burst, would ring like a cup.)
 */
function tick(r: Rig, at: number, o: { freq: number; q: number; gain: number; decay: number }) {
  const source = r.ctx.createBufferSource();
  source.buffer = r.noise;
  const filter = r.ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = o.freq;
  filter.Q.value = o.q;
  const amp = r.ctx.createGain();
  amp.gain.setValueAtTime(o.gain, at);
  amp.gain.exponentialRampToValueAtTime(SILENT, at + o.decay);
  source.connect(filter);
  filter.connect(amp);
  amp.connect(r.out);
  // Start somewhere in the noise, so that no two ticks are the same.
  source.start(at, Math.random() * (NOISE_SECONDS - o.decay - 0.05));
  source.stop(at + o.decay + 0.02);
}

/** One sine that is struck and dies away: a single resonance of a piece of wood. */
function ping(r: Rig, at: number, freq: number, gain: number, decay: number) {
  const osc = r.ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  const amp = r.ctx.createGain();
  // A sine starts at zero, so a full gain from the first instant makes no click of its own.
  amp.gain.setValueAtTime(gain, at);
  amp.gain.exponentialRampToValueAtTime(SILENT, at + decay);
  osc.connect(amp);
  amp.connect(r.out);
  osc.start(at);
  osc.stop(at + decay + 0.02);
}

/** A note: a soft start, then it rings out. */
function note(r: Rig, at: number, freq: number, o: { gain: number; length: number }) {
  const osc = r.ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = freq;
  const amp = r.ctx.createGain();
  amp.gain.setValueAtTime(SILENT, at);
  amp.gain.linearRampToValueAtTime(o.gain, at + 0.015);
  amp.gain.exponentialRampToValueAtTime(SILENT, at + o.length);
  osc.connect(amp);
  amp.connect(r.out);
  osc.start(at);
  osc.stop(at + o.length + 0.02);
}

const between = (low: number, high: number) => low + Math.random() * (high - low);

// --- The sounds ---

// Wood, struck. A piece of wood does not ring at one pitch but at a few that are not
// multiples of each other, and the higher ones die first: those ratios and decays make the
// "tok". On top goes the click of the contact, and under it the low thump of the board
// itself, which does not change pitch.
const PARTIALS = [
  { ratio: 1, gain: 0.6, decay: 0.07 },
  { ratio: 2.76, gain: 0.3, decay: 0.04 },
  { ratio: 5.4, gain: 0.15, decay: 0.02 },
] as const;

/** What a kind of knock is made of: its pitch, how long it rings, and its click and thump. */
interface Wood {
  /** The lowest resonance, in hertz. */
  pitch: number;
  /** A multiple of the ring times above: 1 is a dry knock. */
  ring: number;
  /** Where the click sits, in hertz. */
  clickHz: number;
  /** The board's thump, in hertz. */
  thumpHz: number;
  /** How loud the thump and the click are next to the ringing (1 is as loud as its lowest pitch). */
  thump: number;
  click: number;
}

/**
 * A checker set down on the board, gently: how hard it lands is what makes a "thock", so
 * there is little thump under it, a soft and dull click, and it does not ring long.
 */
const CHECKER: Wood = { pitch: 500, ring: 0.6, clickHz: 2000, thumpHz: 160, thump: 0.12, click: 0.5 };
/** A die: smaller and harder, so higher, drier and sharper. */
const DIE: Wood = { pitch: 880, ring: 0.5, clickHz: 3200, thumpHz: 180, thump: 0.35, click: 0.7 };
/** A checker laid on the others in the tray: lower and duller. */
const TRAY: Wood = { pitch: 340, ring: 1.5, clickHz: 1600, thumpHz: 120, thump: 0.35, click: 0.7 };

/** One knock of `wood` at `at`. No two are quite alike: the pitch wanders a little. */
function knock(r: Rig, at: number, wood: Wood, gain: number) {
  const pitch = wood.pitch * between(0.94, 1.06);
  for (const partial of PARTIALS) {
    ping(r, at, pitch * partial.ratio, gain * partial.gain, partial.decay * wood.ring);
  }
  ping(r, at, wood.thumpHz, gain * wood.thump, 0.03 + 0.03 * wood.ring);
  tick(r, at, { freq: wood.clickHz, q: 0.6, gain: gain * wood.click, decay: 0.006 });
}

/** A checker set down on a point: a light, short tap. */
function move(r: Rig, at: number) {
  knock(r, at, CHECKER, 0.7);
}

/** A checker laid in the tray: a duller knock, and the pile shifting under it. */
function bearOff(r: Rig, at: number) {
  knock(r, at, TRAY, 1);
  knock(r, at + 0.06, TRAY, 0.3);
}

/**
 * When a die that is dropped and bounces hits the board, in seconds after the first hit.
 * Each gap is about two thirds of the one before (a little off, never longer): that
 * speeding up, as the bounces get smaller, is what tells the ear that it is a bounce.
 */
export function bounceTimes(bounces: number, random: () => number = Math.random): number[] {
  const times = [0];
  let gap = 0.16;
  for (let k = 1; k < bounces; k++) {
    times.push((times[k - 1] ?? 0) + gap * (0.95 + 0.1 * random()));
    gap *= 0.66;
  }
  return times;
}

/** How long after the throw the dice first land, as they fly in. */
const DICE_LAND = 0.12;
/** The second die starts a little after the first, as in the animation. */
const DIE_STAGGER = 0.07;

/** Two dice thrown on the board: each lands, and bounces a few times, softer each time. */
function roll(r: Rig, at: number) {
  for (let die = 0; die < 2; die++) {
    const times = bounceTimes(4 + Math.floor(Math.random() * 3));
    const start = at + DICE_LAND + die * DIE_STAGGER;
    for (let k = 0; k < times.length; k++) {
      // Each hit is on another corner or edge, so another pitch.
      const wood = { ...DIE, pitch: DIE.pitch * between(0.85, 1.25) };
      knock(r, start + (times[k] ?? 0), wood, 0.9 * 0.62 ** k);
    }
  }
}

// Notes, in hertz.
const C4 = 261.63;
const E4 = 329.63;
const G4 = 392;
const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const C6 = 1046.5;

/** Won: up the chord to the top. */
function win(r: Rig, at: number) {
  note(r, at, C5, { gain: 0.3, length: 0.3 });
  note(r, at + 0.11, E5, { gain: 0.3, length: 0.3 });
  note(r, at + 0.22, G5, { gain: 0.3, length: 0.3 });
  note(r, at + 0.33, C6, { gain: 0.35, length: 0.8 });
}

/** Lost: two notes, down, and not for long. */
function lose(r: Rig, at: number) {
  note(r, at, E4, { gain: 0.3, length: 0.4 });
  note(r, at + 0.22, C4, { gain: 0.3, length: 0.7 });
}

/** Over, for someone who only watches or for a draw: neither up nor down. */
function end(r: Rig, at: number) {
  note(r, at, G4, { gain: 0.28, length: 0.35 });
  note(r, at + 0.16, C5, { gain: 0.28, length: 0.6 });
}

const SOUNDS: Record<Cue, (r: Rig, at: number) => void> = { roll, move, bearOff, win, lose, end };

/**
 * How loud the speakers get at `volume` (0 to 1). The ear hears loudness on a curve, so a
 * straight line from the slider would put most of the change in its first part: this squares it.
 */
export function gainFor(volume: number): number {
  const level = Math.min(1, Math.max(0, volume));
  return MAX_GAIN * level * level;
}

/**
 * Sounds `cue` after `afterMs` milliseconds, at `volume` (0 to 1). Does nothing if that is
 * 0, or the browser has no audio, or has not let the page make sound yet.
 */
export function playCue(cue: Cue, afterMs: number, volume: number): void {
  if (volume <= 0) return;
  const r = getRig(false);
  if (!r) return;
  if (r.ctx.state !== "running") {
    // Suspended: try to wake it, but this cue is lost, as a late sound would be worse.
    r.ctx.resume().catch(() => {});
    return;
  }
  r.out.gain.value = gainFor(volume);
  SOUNDS[cue](r, r.ctx.currentTime + 0.01 + afterMs / 1000);
}
