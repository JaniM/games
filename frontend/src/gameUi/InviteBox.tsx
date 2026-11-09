import { useRef, useState } from "react";
import { copyText } from "../copyText";

/** The link to share, with a way to copy it. */
export function InviteBox({ url }: { url: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"yes" | "manual" | null>(null);

  async function copy() {
    if (await copyText(url)) {
      setCopied("yes");
      return;
    }
    // Neither way of copying worked (or the person said no): select the link for them.
    if (input.current) selectAll(input.current);
    setCopied("manual");
  }

  return (
    <section className="panel" aria-label="Invite">
      <p>Send this link to the person you want to play with. Anyone who opens it can also watch.</p>
      <div className="invite">
        <input
          ref={input}
          className="invite-url"
          readOnly
          value={url}
          aria-label="Game link"
          onFocus={(event) => selectAll(event.currentTarget)}
        />
        <button className="button" type="button" onClick={copy}>
          Copy link
        </button>
      </div>
      <p className="muted" role="status">
        {copied === "yes" ? "Link copied." : copied === "manual" ? manualCopyHint() : ""}
      </p>
    </section>
  );
}

/** Selects all of a field's text. Safari on iOS ignores `select()` on a read-only field, but not a range. */
function selectAll(field: HTMLInputElement) {
  field.focus();
  field.select();
  field.setSelectionRange(0, field.value.length);
}

/** What to do to copy the selected link by hand: a touch screen has no Ctrl+C. */
function manualCopyHint(): string {
  const touch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  return touch
    ? "Touch and hold the selected link, then choose Copy."
    : "Press Ctrl+C (⌘C) to copy the selected link.";
}
