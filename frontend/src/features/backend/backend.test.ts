import { createDb } from "millpond";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKEND_ID, backend, backendHealth } from "./index";

// Effect tasks run after the flush; one macrotask lets the whole chain settle.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// A fresh db per test, from the same features the app uses.
const dbs: { dispose(): void }[] = [];
function setup(fetchImpl: typeof fetch) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const db = createDb({ features: { backend } });
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.dispose();
  vi.unstubAllGlobals();
});

describe("backend health", () => {
  it("is checking until the request settles, then ok", async () => {
    const db = setup(async () => new Response(null, { status: 200 }));

    db.ops.backend.checkBackend();
    expect(db.read(backendHealth.get(BACKEND_ID))?.state).toBe("checking");

    await settle();
    expect(db.read(backendHealth.get(BACKEND_ID))).toMatchObject({ state: "ok", error: null });
  });

  it("is down with the HTTP status when the backend answers 503", async () => {
    const db = setup(async () => new Response(null, { status: 503 }));

    db.ops.backend.checkBackend();
    await settle();

    expect(db.read(backendHealth.get(BACKEND_ID))).toMatchObject({
      state: "down",
      error: "HTTP 503",
    });
  });

  it("recovers when checked again after a network failure", async () => {
    let up = false;
    const db = setup(async () => {
      if (!up) throw new TypeError("network down");
      return new Response(null, { status: 200 });
    });

    db.ops.backend.checkBackend();
    await settle();
    expect(db.read(backendHealth.get(BACKEND_ID))).toMatchObject({
      state: "down",
      error: "TypeError: network down",
    });

    up = true;
    db.ops.backend.checkBackend();
    await settle();
    expect(db.read(backendHealth.get(BACKEND_ID))?.state).toBe("ok");
  });
});
