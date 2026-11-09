import { useOp, useQuery } from "millpond/react";
import { type FormEvent, useState } from "react";
import { PROFILE_ID, profileState, setName } from "./features/profile";

/** The server accepts 1 to 32 characters. The input counts UTF-16 units, so it is never looser. */
const MAX_NAME_LENGTH = 32;

/**
 * The user's display name, with a way to change it. Shows the name (or a prompt to
 * pick one) as a button; clicking it swaps in a small form.
 */
export function NameControl() {
  const profile = useQuery(profileState.get(PROFILE_ID));
  const save = useOp(setName);
  // null while not editing.
  const [draft, setDraft] = useState<string | null>(null);

  const idle = profile?.state === "idle";
  const name = profile?.state === "saving" ? profile.pending : (profile?.name ?? null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft === null) return;
    if (draft.trim() && draft.trim() !== profile?.name) save({ name: draft });
    setDraft(null);
  }

  if (draft !== null) {
    return (
      <form className="name-control" onSubmit={submit}>
        <input
          className="name-input"
          aria-label="Your name"
          value={draft}
          maxLength={MAX_NAME_LENGTH}
          // biome-ignore lint/a11y/noAutofocus: the form appears because the user asked to edit their name, so focus belongs in it
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(null);
          }}
        />
        <button className="button button-small" type="submit" disabled={!draft.trim()}>
          Save
        </button>
        <button className="button button-quiet button-small" type="button" onClick={() => setDraft(null)}>
          Cancel
        </button>
      </form>
    );
  }

  return (
    <div className="name-control">
      {profile?.error != null && (
        <span className="name-error" role="alert" title={profile.error}>
          Couldn’t save the name
        </span>
      )}
      <button
        className="name-button"
        type="button"
        disabled={!idle}
        aria-busy={!idle}
        title="Change your name"
        onClick={() => setDraft(profile?.name ?? "")}
      >
        {profile === undefined || profile.state === "loading" ? "…" : (name ?? "Set your name")}
      </button>
    </div>
  );
}
