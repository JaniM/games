import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sounds are made by the Web Audio API, which has no stand-in in node. This fake keeps
// count of what was built and started, which is enough to tell a sound from silence and to
// check that it is scheduled when asked and at the volume asked. (How it sounds is for ears.)

class FakeParam {
  value = 0;
  calls: [string, number, number?][] = [];
  setValueAtTime(value: number, at: number) {
    this.calls.push(["set", value, at]);
  }
  linearRampToValueAtTime(value: number, at: number) {
    this.calls.push(["linear", value, at]);
  }
  exponentialRampToValueAtTime(value: number, at: number) {
    this.calls.push(["exp", value, at]);
  }
}

class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  type = "";
  buffer: unknown = null;
  starts: number[] = [];
  connect() {}
  start(at: number) {
    this.starts.push(at);
  }
  stop() {}
}

let contexts: FakeContext[] = [];
class FakeContext {
  static state: "running" | "suspended" = "running";
  state = FakeContext.state;
  currentTime = 10;
  sampleRate = 8000;
  destination = {};
  made: FakeNode[] = [];
  resume = vi.fn(async () => {});
  constructor() {
    contexts.push(this);
  }
  private node() {
    const node = new FakeNode();
    this.made.push(node);
    return node;
  }
  createGain = () => this.node();
  createOscillator = () => this.node();
  createBufferSource = () => this.node();
  createBiquadFilter = () => this.node();
  createBuffer(_channels: number, length: number) {
    return { duration: 1, getChannelData: () => new Float32Array(length) };
  }
  get started() {
    return this.made.flatMap((node) => node.starts);
  }
}

// The module keeps its audio in module state, so each test loads a fresh copy.
async function load() {
  vi.resetModules();
  return import("./sounds");
}

beforeEach(() => {
  contexts = [];
  FakeContext.state = "running";
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("navigator", { userActivation: { hasBeenActive: true } });
});
afterEach(() => vi.unstubAllGlobals());

describe("playing a cue", () => {
  it("makes sound for every cue", async () => {
    const { playCue } = await load();
    for (const cue of ["roll", "move", "bearOff", "win", "lose", "end"] as const) {
      const before = contexts[0]?.started.length ?? 0;
      playCue(cue, 0, 1);

      expect(contexts[0]?.started.length ?? 0, cue).toBeGreaterThan(before);
    }
  });

  it("schedules a cue after its delay, from the audio clock", async () => {
    const { playCue } = await load();
    playCue("move", 450, 1);

    const starts = contexts[0]?.started ?? [];
    // 10 s on the clock, and 0.45 s to wait.
    expect(Math.min(...starts)).toBeGreaterThanOrEqual(10.45);
    expect(Math.max(...starts)).toBeLessThan(10.6);
  });

  it("spreads a roll over time, as several hits and not one", async () => {
    const { playCue } = await load();
    playCue("roll", 0, 1);

    const starts = new Set((contexts[0]?.started ?? []).map((at) => at.toFixed(3)));
    expect(starts.size).toBeGreaterThan(5);
    // The first hit is as the dice land, not at the moment of the throw, and it is over in a second.
    const times = [...starts].map(Number);
    expect(Math.min(...times)).toBeGreaterThan(10.1);
    expect(Math.max(...times)).toBeLessThan(11);
  });

  it("never glides in pitch: a falling tone is a drum, and wood has no such thing", async () => {
    const { playCue } = await load();
    for (const cue of ["roll", "move", "bearOff"] as const) playCue(cue, 0, 1);

    const oscillators = (contexts[0]?.made ?? []).filter((node) => node.frequency.value > 0);
    expect(oscillators.length).toBeGreaterThan(10);
    for (const node of oscillators) expect(node.frequency.calls).toEqual([]);
  });

  it("rings at pitches that are not multiples of each other, as wood does", async () => {
    const { playCue } = await load();
    playCue("move", 0, 1);

    // The sines above the board's low thump, which is a tone of its own.
    const pitches = (contexts[0]?.made ?? [])
      .filter((node) => node.type === "sine" && node.frequency.value > 300)
      .map((node) => node.frequency.value)
      .sort((a, b) => a - b);
    const [low, ...rest] = pitches;
    expect(rest.length).toBeGreaterThanOrEqual(2);
    for (const hz of rest) {
      const ratio = hz / (low ?? 1);
      expect(Math.abs(ratio - Math.round(ratio))).toBeGreaterThan(0.1);
    }
  });

  it("is silent at volume 0, and does not even wake the audio", async () => {
    const { playCue } = await load();
    playCue("roll", 0, 0);

    expect(contexts).toHaveLength(0);
  });

  it("is quieter at a lower volume, and the middle of the slider is well below half of full", async () => {
    const { gainFor, playCue } = await load();
    expect(gainFor(0)).toBe(0);
    expect(gainFor(0.5)).toBeLessThan(gainFor(1) / 2);
    expect(gainFor(2)).toBe(gainFor(1));

    playCue("move", 0, 0.5);
    // The first node made is the master gain.
    expect(contexts[0]?.made[0]?.gain.value).toBeCloseTo(gainFor(0.5));
  });

  it("makes one audio context and reuses it", async () => {
    const { playCue } = await load();
    playCue("move", 0, 1);
    playCue("move", 0, 1);

    expect(contexts).toHaveLength(1);
  });

  it("drops a cue while the audio is suspended, and tries to wake it", async () => {
    FakeContext.state = "suspended";
    const { playCue } = await load();
    playCue("move", 0, 1);

    expect(contexts[0]?.started).toEqual([]);
    expect(contexts[0]?.resume).toHaveBeenCalled();
  });

  it("makes no audio, and no noise, before the page has been used", async () => {
    vi.stubGlobal("navigator", { userActivation: { hasBeenActive: false } });
    const { playCue } = await load();
    playCue("move", 0, 1);

    expect(contexts).toHaveLength(0);
  });

  it("does nothing in a browser without audio", async () => {
    vi.stubGlobal("AudioContext", undefined);
    const { playCue } = await load();

    expect(() => playCue("win", 0, 1)).not.toThrow();
  });
});

describe("the bounces of a die", () => {
  it("come closer and closer together, as a bouncing thing does", async () => {
    const { bounceTimes } = await load();
    // The worst case for the jitter either way, and the middle.
    for (const random of [() => 0, () => 0.5, () => 1]) {
      const times = bounceTimes(6, random);
      const gaps = times.slice(1).map((at, i) => at - (times[i] ?? 0));

      expect(times[0]).toBe(0);
      expect(gaps).toHaveLength(5);
      for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeLessThan(gaps[i - 1] ?? 0);
    }
  });

  it("make a single hit when there is one bounce", async () => {
    const { bounceTimes } = await load();

    expect(bounceTimes(1)).toEqual([0]);
  });
});

describe("setting a checker down", () => {
  // Every `ping` makes an oscillator and then the gain that shapes it, so each sine is
  // followed by its envelope. This reads them as pairs: the pitch, how loud it starts, and
  // when it has died away (in seconds after the cue's start).
  const START = 10.01; // the clock (10) and the little lead the cue is given
  async function pingsOf(cue: "move" | "roll" | "bearOff") {
    const { playCue } = await load();
    playCue(cue, 0, 1);
    const made = contexts.at(-1)?.made ?? [];
    return made.flatMap((node, i) => {
      const amp = made[i + 1];
      if (node.type !== "sine" || !amp) return [];
      const start = amp.gain.calls.find(([kind]) => kind === "set");
      const end = amp.gain.calls.find(([kind]) => kind === "exp");
      return [{ hz: node.frequency.value, gain: start?.[1] ?? 0, ends: (end?.[2] ?? 0) - START }];
    });
  }
  const loudest = (pings: { gain: number }[]) => Math.max(...pings.map((ping) => ping.gain));

  it("is gentler than a die landing or a checker laid in the tray", async () => {
    const move = loudest(await pingsOf("move"));

    expect(move).toBeLessThan(loudest(await pingsOf("roll")));
    expect(move).toBeLessThan(loudest(await pingsOf("bearOff")));
  });

  it("has hardly any thump under it, which is what a hard landing would add", async () => {
    const pings = await pingsOf("move");
    const thump = pings.find((ping) => ping.hz < 300);
    const ring = pings.filter((ping) => ping.hz >= 300);

    expect(thump).toBeDefined();
    // A fifth of the ring, where a die's thump is more than half of it.
    expect(thump?.gain ?? 1).toBeLessThan(loudest(ring) * 0.25);
  });

  it("is over almost at once", async () => {
    const pings = await pingsOf("move");

    expect(Math.max(...pings.map((ping) => ping.ends))).toBeLessThan(0.08);
  });
});
