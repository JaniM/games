import { createDb } from "millpond";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeStorage, settle } from "../../testing";
import { DEFAULT_VOLUME, SOUND_ID, soundSettings, sound } from "./index";
import { STORAGE_KEY, loadVolume } from "./storage";

const dbs: { dispose(): void }[] = [];
function setup(storage = fakeStorage()) {
  vi.stubGlobal("localStorage", storage);
  const db = createDb({ features: { sound } });
  dbs.push(db);
  return { db, storage };
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
  vi.unstubAllGlobals();
});

const volume = (db: ReturnType<typeof setup>["db"]) => db.read(soundSettings.get(SOUND_ID))?.volume;

describe("the volume", () => {
  it("starts at the default when nothing was saved", () => {
    const { db } = setup();
    db.ops.sound.startSound({ stored: loadVolume() });

    expect(volume(db)).toBe(DEFAULT_VOLUME);
  });

  it("starts where the last visit ended", () => {
    const { db } = setup(fakeStorage({ [STORAGE_KEY]: "0.25" }));
    db.ops.sound.startSound({ stored: loadVolume() });

    expect(volume(db)).toBe(0.25);
  });

  it("starts at the default when what was saved makes no sense", () => {
    for (const junk of ["loud", "", "1.5", "-1", "NaN"]) {
      const { db } = setup(fakeStorage({ [STORAGE_KEY]: junk }));
      db.ops.sound.startSound({ stored: loadVolume() });

      expect(volume(db), junk).toBe(DEFAULT_VOLUME);
    }
  });

  it("keeps the choice made before startup finishes", () => {
    const { db } = setup();
    db.ops.sound.setVolume({ volume: 0 });
    db.ops.sound.startSound({ stored: 0.9 });

    expect(volume(db)).toBe(0);
  });

  it("can be set, cut to the range, and silenced", () => {
    const { db } = setup();
    db.ops.sound.setVolume({ volume: 0.4 });
    expect(volume(db)).toBe(0.4);
    db.ops.sound.setVolume({ volume: 7 });
    expect(volume(db)).toBe(1);
    db.ops.sound.setVolume({ volume: -3 });
    expect(volume(db)).toBe(0);
  });

  it("is saved when it changes", async () => {
    const { db, storage } = setup();
    db.ops.sound.setVolume({ volume: 0.4 });
    await settle();

    expect(storage.data.get(STORAGE_KEY)).toBe("0.4");
  });

  it("works from memory when storage cannot be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = setup(fakeStorage({}, true));
    db.ops.sound.setVolume({ volume: 0.4 });
    await settle();

    expect(volume(db)).toBe(0.4);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
