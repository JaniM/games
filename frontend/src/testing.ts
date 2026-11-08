// Stand-ins for the browser and the backend, shared by the feature tests.

/** Effect tasks run after the flush; one macrotask lets the whole chain settle. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

export interface Credentials {
  userId: string;
  accessToken: string;
}

/** The credentials the fake server hands out to its nth registration. */
export const issued = (n: number): Credentials => ({ userId: `user-${n}`, accessToken: `token-${n}` });

const NAME_ERROR = "name must be 1 to 32 characters, without control characters";

/**
 * A stand-in for the backend, with the same contract: `POST /api/register` issues
 * credentials, `GET /api/me` and `PATCH /api/me` act on the user a bearer token
 * belongs to, and any other path answers 200 to a known token. Unknown tokens get 401.
 *
 * `users` maps access tokens to users. Clearing it makes the server forget everyone.
 */
export function fakeServer() {
  const users = new Map<string, { userId: string; name: string | null }>();
  let registrations = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const path = String(input);
    if (path === "/api/register") {
      registrations += 1;
      const credentials = issued(registrations);
      users.set(credentials.accessToken, { userId: credentials.userId, name: null });
      return json(credentials, 201);
    }

    const token = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "");
    const user = token ? users.get(token) : undefined;
    if (!user) return new Response(null, { status: 401 });
    if (path !== "/api/me") return json({});

    if (init?.method === "PATCH") {
      const name = String(JSON.parse(String(init.body)).name ?? "").trim();
      if (!name || [...name].length > 32) return new Response(NAME_ERROR, { status: 422 });
      user.name = name;
    }
    return json(user);
  };

  return {
    users,
    fetchImpl,
    /** Makes the server know `credentials`, as if they were registered on an earlier visit. */
    addUser(credentials: Credentials, name: string | null = null) {
      users.set(credentials.accessToken, { userId: credentials.userId, name });
    },
  };
}

/** A `localStorage` stand-in. `failWrites` mimics a full or blocked store. */
export function fakeStorage(initial: Record<string, string> = {}, failWrites = false) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new DOMException("quota exceeded", "QuotaExceededError");
      data.set(key, value);
    },
  };
}
