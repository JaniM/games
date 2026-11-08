import { table } from "millpond";
import { z } from "zod";

/** The singleton key of the one `soundSettings` row. */
export const SOUND_ID = "current";

/** How loud the game sounds are before the person chooses: a little under full. */
export const DEFAULT_VOLUME = 0.7;

/**
 * How loud this browser plays the game sounds, from 0 (silent) to 1. A single row, which the
 * `persistSound` effect keeps in local storage. Before `startSound` has run there is no row,
 * and the volume is the default.
 */
export const soundSettings = table(
  z.object({ id: z.string(), volume: z.number().min(0).max(1) }),
  { key: "id" },
);
