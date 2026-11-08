/**
 * Puts `text` on the clipboard. True if it got there, false if the browser would not.
 * Call it straight from a click: browsers only let a page copy as the answer to one.
 *
 * Two ways, because neither works everywhere:
 *
 * - `navigator.clipboard` is the proper one, but a browser only has it on a secure page
 *   (https, or localhost). On a phone that opens the dev server by its address on the
 *   network (`pnpm dev:lan`) it is not there at all.
 * - `document.execCommand("copy")` is deprecated but works on any page, and copies what is
 *   selected. Safari on iOS needs the text selected by range (`select()` alone does nothing
 *   there), and it won't select a field that isn't in the page, so the field is put in the
 *   page, out of sight.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // The person said no, or the browser did. The other way may still work.
    }
  }
  return copyBySelection(text);
}

function copyBySelection(text: string): boolean {
  const field = document.createElement("textarea");
  field.value = text;
  // Read-only keeps the keyboard from opening on a phone as the field is selected.
  field.setAttribute("readonly", "");
  // Out of sight, but not `display: none`, which can't be selected. 16px: smaller text makes
  // iOS zoom in on a field that is selected.
  Object.assign(field.style, {
    position: "fixed",
    top: "0",
    left: "-9999px",
    fontSize: "16px",
    opacity: "0",
  });
  document.body.appendChild(field);
  try {
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
