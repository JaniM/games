/**
 * A random (version 4) uuid.
 *
 * `crypto.randomUUID` exists only on secure pages (https, or localhost). A phone that opens
 * the dev server over the local network gets plain http, where it is missing and calling it
 * throws, so this builds the uuid from `getRandomValues`, which every page has.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // the RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  const part = (from: number, to: number) => hex.slice(from, to).join("");
  return `${part(0, 4)}-${part(4, 6)}-${part(6, 8)}-${part(8, 10)}-${part(10, 16)}`;
}
