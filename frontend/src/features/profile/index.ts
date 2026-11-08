import { feature } from "millpond";
import { loadProfile, saveName } from "./effects";
import {
  nameSaveFailed,
  nameSaved,
  profileLoadFailed,
  profileLoaded,
  profileLoading,
  setName,
} from "./ops";
import { profileState } from "./tables";

export const profile = feature({
  tables: { profileState },
  ops: { profileLoading, profileLoaded, profileLoadFailed, setName, nameSaved, nameSaveFailed },
  effects: { loadProfile, saveName },
});

// Components import definitions by value; they never need the assembled db.
export { setName } from "./ops";
export { PROFILE_ID, profileState } from "./tables";
