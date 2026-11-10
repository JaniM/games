import { useOp, useQuery } from "millpond/react";
import { DEFAULT_VOLUME, SOUND_ID, setVolume, soundSettings } from "../features/sound";
import { playCue } from "../longBackgammon/sounds";

/** The slider's steps: a hundred would make the arrow keys crawl. */
const STEPS = 20;

/** The text a screen reader says for a volume. */
export function volumeText(volume: number): string {
  return volume <= 0 ? "Off" : `${Math.round(volume * 100)}%`;
}

/** A slider for how loud the game sounds are. At its left end they are off. */
export function VolumeControl() {
  // From 0 (silent) to 1.
  const volume = useQuery(soundSettings.get(SOUND_ID))?.volume ?? DEFAULT_VOLUME;
  const change = useOp(setVolume);
  // Letting go of the slider plays a knock, so that the new level can be heard.
  const settle = () => playCue("move", 0, volume);
  return (
    <label className="volume">
      <span className="volume-label">Sound</span>
      <input
        className="volume-slider"
        type="range"
        min={0}
        max={STEPS}
        step={1}
        value={Math.round(volume * STEPS)}
        aria-valuetext={volumeText(volume)}
        onChange={(event) => change({ volume: Number(event.target.value) / STEPS })}
        onPointerUp={settle}
        onKeyUp={settle}
      />
    </label>
  );
}
