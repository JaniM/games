export interface VolumeControlProps {
  /** From 0 (silent) to 1. */
  volume: number;
  onChange: (volume: number) => void;
  /** The person has let go of the slider: a good time to play a sound at the new level. */
  onSettle: () => void;
}

/** The slider's steps: a hundred would make the arrow keys crawl. */
const STEPS = 20;

/** The text a screen reader says for a volume. */
export function volumeText(volume: number): string {
  return volume <= 0 ? "Off" : `${Math.round(volume * 100)}%`;
}

/** A slider for how loud the game sounds are. At its left end they are off. */
export function VolumeControl({ volume, onChange, onSettle }: VolumeControlProps) {
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
        onChange={(event) => onChange(Number(event.target.value) / STEPS)}
        onPointerUp={onSettle}
        onKeyUp={onSettle}
      />
    </label>
  );
}
