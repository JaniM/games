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

/** A game id the way the server makes them: 12 characters of lower case letters and digits. Here the nth, so tests can name it. */
export const gameIdOf = (n: number) => `game${String(n).padStart(8, "0")}`;

/** The computer opponent's user id on the fake server. It shows up as the player named "Bot". */
export const BOT_USER_ID = "bot";

export interface FakeGame {
  id: string;
  kind: string;
  /** User ids by seat. */
  players: string[];
  updatedAt: number;
  /** The game has ended. */
  finished?: boolean;
  /** The positions the game has been in, as `GET /api/games/{id}/history` lists them. Left out, there are none. */
  history?: { revision: number; state: unknown }[];
}

/**
 * A stand-in for the backend, with the same contract: `POST /api/register` issues
 * credentials, `GET /api/me` and `PATCH /api/me` act on the user a bearer token
 * belongs to, `POST /api/games`, `GET /api/games` and `POST /api/games/{id}/join`
 * keep a list of games (two seats each), `POST` and `DELETE /api/games/{id}/rematch` answer
 * as the real ones do to a game that is unknown (404), not the user's (403) or not over (409),
 * `GET /api/games/{id}/history` lists the positions the game was given (404 for an unknown game),
 * and any other path answers 200 to a known token. Unknown tokens get 401.
 *
 * `users` maps access tokens to users. Clearing it makes the server forget everyone.
 * `games` maps game ids to games.
 */
export function fakeServer() {
  const users = new Map<string, { userId: string; name: string | null }>();
  const games = new Map<string, FakeGame>();
  let registrations = 0;
  let clock = 1_700_000_000_000;
  /** The next time on the server's clock: every change is a second after the last. */
  const tick = () => {
    clock += 1000;
    return clock;
  };

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
    const join = /^\/api\/games\/([^/]+)\/join$/.exec(path);
    const rematch = /^\/api\/games\/([^/]+)\/rematch$/.exec(path);
    const history = /^\/api\/games\/([^/]+)\/history$/.exec(path);
    if (path === "/api/games" && init?.method === "POST") {
      const { kind, bot = false } = JSON.parse(String(init.body)) as { kind: string; bot?: boolean };
      if (kind !== "long-backgammon") return new Response("unknown kind of game", { status: 422 });
      const game = {
        id: gameIdOf(games.size + 1),
        kind,
        players: bot ? [user.userId, BOT_USER_ID] : [user.userId],
        updatedAt: tick(),
      };
      games.set(game.id, game);
      return json({ gameId: game.id, seat: 0 }, 201);
    }
    if (path === "/api/games") {
      const mine = [...games.values()].filter((game) => game.players.includes(user.userId));
      return json({
        games: mine.map((game) => ({
          gameId: game.id,
          kind: game.kind,
          seat: game.players.indexOf(user.userId),
          joined: game.players.length,
          started: game.players.length === 2,
          finished: game.finished ?? false,
          updatedAt: game.updatedAt,
          playerNames: game.players.map((id) =>
            id === BOT_USER_ID
              ? "Bot"
              : ([...users.values()].find((u) => u.userId === id)?.name ?? null),
          ),
        })),
      });
    }
    if (join) {
      const game = games.get(join[1] ?? "");
      if (!game) return new Response(null, { status: 404 });
      if (!game.players.includes(user.userId)) {
        if (game.players.length >= 2) return new Response("the game is full", { status: 409 });
        game.players.push(user.userId);
        game.updatedAt = tick();
      }
      return json({ gameId: game.id, seat: game.players.indexOf(user.userId) });
    }
    if (history) {
      const game = games.get(history[1] ?? "");
      if (!game) return new Response(null, { status: 404 });
      return json({ gameId: game.id, kind: game.kind, stateVersion: 1, positions: game.history ?? [] });
    }
    if (rematch) {
      const game = games.get(rematch[1] ?? "");
      if (!game) return new Response(null, { status: 404 });
      if (!game.players.includes(user.userId)) return new Response("not a player", { status: 403 });
      if (!game.finished) return new Response("the game is not over yet", { status: 409 });
      return json({ rematch: null });
    }
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
    games,
    fetchImpl,
    /** Makes the server know `credentials`, as if they were registered on an earlier visit. */
    addUser(credentials: Credentials, name: string | null = null) {
      users.set(credentials.accessToken, { userId: credentials.userId, name });
    },
    /** Puts a game on the server, as if somebody had created it. */
    addGame(game: Omit<FakeGame, "updatedAt"> & { updatedAt?: number }) {
      games.set(game.id, { updatedAt: tick(), ...game });
    },
  };
}

/**
 * What the client registers on a socket. The real `WebSocket` hands it an `Event`; the fake
 * sends only the fields the client reads (`data`, `code`).
 */
type Listener = (event: Event) => void;

/**
 * A `WebSocket` stand-in that the test drives by hand: it records what the client sends
 * (parsed from JSON), and the test says when it opens, what the server sends and how it
 * closes. Install it with `vi.stubGlobal("WebSocket", FakeWebSocket)`.
 */
export class FakeWebSocket {
  /** Every socket made since `reset`, oldest first. */
  static instances: FakeWebSocket[] = [];

  static reset() {
    FakeWebSocket.instances = [];
  }

  static get last(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("no socket was opened");
    return socket;
  }

  readonly url: string;
  readyState = 0;
  /** What the client sent, parsed. */
  sent: Record<string, unknown>[] = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    if (this.readyState !== 1) throw new Error("the socket is not open");
    this.sent.push(JSON.parse(data));
  }

  /** The client closes it. */
  close(code = 1000) {
    this.serverClose(code);
  }

  // What the test does, as the server and the network:

  /** The connection is made. */
  open() {
    this.readyState = 1;
    this.dispatch("open", {});
  }

  /** The server sends a message. */
  receive(message: unknown) {
    this.dispatch("message", { data: JSON.stringify(message) });
  }

  /** The connection ends, with a close code. Does nothing if it has ended already. */
  serverClose(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch("close", { code });
  }

  private dispatch(type: string, event: object) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event as Event);
  }
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
