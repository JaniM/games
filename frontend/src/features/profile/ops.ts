import { op } from "millpond";
import { PROFILE_ID, profileState } from "./tables";

/**
 * A load is starting, because the session just became ready. That can be a new
 * user, so whatever name we held is dropped. A save in flight is kept: it is
 * sent again with the new token, and its result wins.
 */
export const profileLoading = op((tx) => {
  if (tx.read(profileState.get(PROFILE_ID))?.state === "saving") return;
  tx.upsert(profileState, {
    id: PROFILE_ID,
    name: null,
    state: "loading",
    pending: null,
    error: null,
  });
});

/** Records the name the server has. Ignored unless a load is running. */
export const profileLoaded = op((tx, result: { name: string | null }) => {
  if (tx.read(profileState.get(PROFILE_ID))?.state !== "loading") return;
  tx.update(profileState, PROFILE_ID, { state: "idle", name: result.name, error: null });
});

/** Records a load that didn't work. Ignored unless a load is running. */
export const profileLoadFailed = op((tx, result: { error: string }) => {
  if (tx.read(profileState.get(PROFILE_ID))?.state !== "loading") return;
  tx.update(profileState, PROFILE_ID, { state: "idle", error: result.error });
});

/**
 * Asks the `saveName` effect to save a new name. Ignored while the profile is
 * loading or saving, and for a name that is empty once trimmed. The server has
 * the final say on what a valid name is.
 */
export const setName = op((tx, args: { name: string }) => {
  const name = args.name.trim();
  if (!name || tx.read(profileState.get(PROFILE_ID))?.state !== "idle") return;
  tx.update(profileState, PROFILE_ID, { state: "saving", pending: name, error: null });
});

/** Records the name the server saved. */
export const nameSaved = op((tx, result: { name: string | null }) => {
  tx.update(profileState, PROFILE_ID, {
    state: "idle",
    name: result.name,
    pending: null,
    error: null,
  });
});

/** Records a save that didn't work. The old name stays. */
export const nameSaveFailed = op((tx, result: { error: string }) => {
  tx.update(profileState, PROFILE_ID, { state: "idle", pending: null, error: result.error });
});
