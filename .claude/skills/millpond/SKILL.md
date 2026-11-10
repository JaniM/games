---
name: millpond
description: How to use millpond, the in-memory reactive database used for client state in this repo's React frontend. Use when writing or changing frontend state, tables, ops, aggregates, effects, queries, or React components that call useQuery/useOp/DbProvider, or when writing tests for them.
---

# millpond

An in-memory reactive database for TypeScript. All client state lives in **tables**; the only way to write is a predefined **op**; everything else (queries, aggregates, effects, React hooks) reacts to committed ops. Source: https://github.com/JaniM/millpond (`spec.md` there is the full design; `demo/db.ts` and `demo/App.tsx` are the best worked examples).

This skill was written from the library source at commit `a0c96a5` (2026-10-23). The upstream README still says "scaffold, engine not implemented". That banner is stale: the engine is implemented. If behaviour contradicts this file, trust the installed package's `.d.ts` and upstream `spec.md`.

## Install

The package is `0.0.0` and the API may still move. **It has been unpublished from npm**, so `pnpm add millpond` fails and the upstream README's install line is wrong. Install from git and pin the commit. `dist/` is committed upstream, so no build step is needed:

```sh
pnpm add github:JaniM/millpond#a0c96a59cd4677fed5ac6ee2ec0da75a2c13e5c7 zod react react-dom
```

pnpm needs the **full 40-character commit hash**; a short hash fails with "Could not resolve ... to a commit". Any Standard Schema library works for schemas (Zod, Valibot, ArkType). React >= 18 is an optional peer dependency. Imports: core from `"millpond"`, React bindings from `"millpond/react"`.

## Mental model

```
op (sync tx)  ──commit──▶ tables ──flush (microtask)──▶ aggregates ─▶ subscribers/useQuery ─▶ effects
     ▲                                                                                          │
     └──────────────────────────── run(op) from async tasks ◀───────────────────────────────────┘
```

- **One write path.** Components, effects and ops all write by calling ops. Never mutate rows.
- **Reactions are batched.** Ops commit immediately; aggregates, subscribers and effects run once per batch in a microtask flush.
- **Loading and error state are rows.** Async work is modelled as a row (for example a `pending` request) that an effect picks up; the UI just queries that row.

## Tables

```ts
import { table } from "millpond";
import { z } from "zod";

export const messages = table(
  z.object({
    id: z.string(),
    threadId: z.string(),
    sentAt: z.number(),
    editedAt: z.number().nullable(),
    body: z.string(),
  }),
  {
    key: "id",                           // single primitive field, always indexed
    generate: () => crypto.randomUUID(), // optional: makes `id` optional in tx.insert
    indexes: { byThread: ["threadId", "sentAt"] }, // named composite indexes
  },
);
```

- Key and index columns must be `string | number | boolean | null` (nullable ok). Other fields can be any schema type but cannot be indexed.
- `all` and `get` are reserved and cannot be index names.
- **The schema must not transform.** The validated output must deep-equal the row you wrote: no `.default()`, `.transform()`, `.pipe()`. This is checked at write time (not at `createDb`), and so are async schemas, which throw. Schemas only validate, on every write including aggregate output, unless `createDb({ validate: false })`.
- Rows are stored as given and are **immutable** (shallow-frozen by default). Never mutate a row or nested value. Updates create new rows, and every update counts as a change even if values are identical.
- Declare tables as standalone exported values. They don't belong to any db until registered in a feature.

## Queries

A query reads one table through one index. Queries are plain values; build them anywhere, including inline in render.

```ts
messages.all()                                   // every row
messages.get("m1")                               // Row | undefined
messages.byThread.threadIdEq("t1")               // prefix of the index
messages.byThread.threadIdEq("t1").sentAtGte(a).sentAtLt(b) // prefix, then a range
```

- Methods are named after the next index column: `<col>Eq` advances the prefix; `<col>Gt/Gte/Lt/Lte` end it (a lower and an upper bound on the same column form a range). Autocomplete only offers the valid next column.
- Results are `readonly Row[]` in **unspecified order**. Sort in the component (`useMemo`) or index the sort column and use a range.
- Equal queries share one subscription and one cached result. Unchanged results keep the same array identity, so rebuilding a query every render is free.
- `db.read(q)` one-shot; `db.subscribe(q, cb)` calls `cb` immediately with the current result, then once per flush where it changed; returns an unsubscribe function.

## Ops

```ts
import { op } from "millpond";

export const send = op((tx, m: { threadId: string; body: string }) => {
  const id = tx.insert(messages, { ...m, sentAt: Date.now(), editedAt: null });
  tx.update(threads, m.threadId, { lastMessageId: id });
  return id; // ops may return a value (sync only)
});

export const archive = op((tx, { threadId }: { threadId: string }) => {
  for (const m of tx.read(messages.byThread.threadIdEq(threadId))) tx.delete(messages, m.id);
  tx.update(threads, threadId, { archived: true });
});
```

| `tx.` call | Notes |
| --- | --- |
| `insert(table, row)` | Returns the key. Throws if the key exists. A caller-supplied key beats `generate`. |
| `update(table, key, patch)` or `update(table, key, row => patch)` | Shallow merge. Throws if the key is missing or the patch changes the key. |
| `upsert(table, row)` | Insert or replace; returns the key. |
| `delete(table, key)` | Throws if the key is missing. |
| `read(query)` | Sees the op's own writes. |
| `run(otherOp, args)` | Nested op as a savepoint; if it throws and you catch, only its writes roll back. |

- An op is all-or-nothing: if it throws, nothing is committed and the error is rethrown to the caller.
- Ops are **synchronous**. Returning a promise is a type error and throws at runtime. Do async work in an effect.
- Prefer returning **keys** over rows (a returned row is a snapshot).
- Writing to an aggregate table throws. Touching a table not registered in the db throws when the op runs.
- **Aggregates read inside an op reflect the state before the op started**, never the op's own writes.
- Ops cannot be called from subscriber callbacks, aggregate `compute` functions, or effect `watch` functions (throws).
- Calling: `db.ops.<feature>.<op>(args)` (app code), `db.run(op, args)`, `tx.run`, `ctx.run` (in tasks), `useOp(op)` (components). Features should reference ops by value, not via the assembled `db`.

## Aggregates (derived tables, instead of joins)

```ts
import { aggregate, count, sum, min, max } from "millpond";

export const threadStats = aggregate({
  table: table(z.object({ threadId: z.string(), reactions: z.number() }), { key: "threadId" }),
  inputs: [threads, messages, reactions],           // every table it may read; must already exist (no cycles)
  compute: (q, emit) =>
    q.each(threads.all(), (thread) =>
      emit({
        threadId: thread.id,
        reactions: q.reduce(
          messages.byThread.threadIdEq(thread.id),
          (msg) => q.reduce(reactions.byMessage.messageIdEq(msg.id), count),
          sum,
        ),
      })),
});
```

`aggregate()` returns its `table`, so it is queried like any table (`threadStats.get(id)`), and it must be registered in a feature's `tables`.

Scope API `q` (reads only declared inputs; anything else is a type error and throws):

- `q.each(query, (row, prev) => ..., opts?)`: one scope per row (keyed by primary key); `prev` is the row at the scope's previous run. Returns an array of results.
- `q.reduce(query, [mapFn,] reducer, opts?)`: fold with a reducer. `count`, `sum`, `min`, `max` are built in (`min`/`max` return `undefined` for an empty group). `q.reduce(query, count)` counts rows.
- `q.with(query, (rows) => ..., opts?)`: one scope over the whole result.
- `q.read(query)`: plain read in the current scope.
- `{ rerunOn: ["field", ...] }` on any of them: only changes to those fields rerun the scope (`[]` means only entering/leaving the query reruns it).
- `emit(row)` can be called from any scope. Two scopes emitting the same key is an error.
- Compute must be **pure**: no ops, no side effects. If it throws, the scope keeps its previous output and the error goes to `onError`.
- Custom reducer: `{ init, add, remove, result? }`. If the accumulator is mutated in place, provide `result`.

## Effects (all async work)

```ts
import { effect } from "millpond";

export const loadThread = effect({
  inputs: [loadRequests],
  watch: (q, task) =>
    q.each(loadRequests.byStatus.statusEq("pending"), (req) =>
      task(
        async ({ db, run, signal, note }) => {
          try {
            const res = await fetch(`/api/threads/${req.threadId}`, { signal });
            run(threadLoaded, { requestId: req.id, data: await res.json() });
          } catch (err) {
            if (!signal.aborted) run(loadFailed, { requestId: req.id, message: String(err) });
          }
        },
        { label: `load ${req.threadId}` },
      )),
});
```

- One task per scope (usually per row). A task **starts** when its scope is created, is **aborted and restarted** when the scope reruns (row changed in a field `rerunOn` covers), and is **aborted** when the scope is disposed (row leaves the query) or `db.dispose()` runs.
- Task context: `db` (read-only view of committed state), `run(op, args, { ignoreAbort? })` (the only way to write, returns the op's result), `signal` (pass it to `fetch` and timers), `note(text)` (introspection).
- After an abort, `run` throws `AbortError`, which stops the task. Use `{ ignoreAbort: true }` only for cleanup.
- Tasks handle their own errors; uncaught ones go to `onError` (abort errors excluded).
- A task that updates its own row restarts itself. Use `rerunOn` to list only the fields that should restart it (e.g. `{ rerunOn: ["url"] }` so progress updates don't). Restart loops are capped at 100 consecutive flushes; an effect hitting the cap is disabled permanently and reported to `onError`.
- `row` captured in a task is a snapshot; read current values through `ctx.db.read(...)`.
- One task for a whole query: `q.with(query, (rows) => { if (rows.length) task(...) })`.
- Effects may not take `sys.*` tables as inputs.

Pattern for server data: an op inserts a request row (`status: "pending"`), an effect fetches and calls a result op, the result op writes data and marks the request `done`/`failed` with an error message. The UI queries the request row for loading/error state and has a retry op that sets it back to `pending`.

## Features and the db

```ts
import { createDb, feature } from "millpond";

export const chat = feature({
  tables: { threads, messages, loadRequests, threadStats }, // aggregates are tables too
  ops: { send, archive, openThread, threadLoaded, loadFailed },
  effects: { loadThread },
});

export const db = createDb({
  features: { chat, logs },
  // validate: true, freeze: true   (defaults)
  // introspect: true | { history: 20 }   (opt-in sys.* tables)
  onError: (err, { db, source }) => db.run(recordError, { source, message: String(err) }),
});

db.ops.chat.send({ threadId: "t1", body: "hi" });
```

- Registered name = feature key + key in the feature (`chat.send`); the name only shows up in `db.ops`, errors and introspection. Dispatch is by value identity.
- **Everything must be registered at creation**; nothing can be added later. Registering the same definition twice, or an aggregate/effect whose input isn't registered, makes `createDb` throw.
- `onError` runs after the flush and may call ops (the demo records errors as rows). If it throws, or is absent, the error is rethrown from a fresh microtask (shows in `window.onerror` / console).
- `db.dispose()` aborts tasks and drops subscriptions; afterwards ops, reads and new subscriptions throw, but unsubscribe and repeated `dispose()` are silent.
- Same features can back several db instances (one per test).
- Type to use where features aren't statically known: `AnyDb`. A concrete `Db<Features>` is **not** assignable to a `Db` with different features.

## React

```tsx
import { DbProvider, useOp, useQuery } from "millpond/react";

createRoot(root).render(<DbProvider db={db}><App /></DbProvider>); // once, at the root

function Thread({ threadId }: { threadId: string }) {
  const rows = useQuery(messages.byThread.threadIdEq(threadId)); // readonly Row[]
  const stats = useQuery(threadStats.get(threadId));             // Row | undefined
  const send = useOp(sendOp);                                    // (args) => result
  return <MessageList messages={rows} onSend={(body) => send({ threadId, body })} />;
}
```

- `useQuery(query)` is `useSyncExternalStore`-based; it re-renders only when that query's result changes. Rebuilding the query each render is fine.
- `useOp(op)` returns a function bound to the provider's db, typed from the op value; an `Op<void>` is called with no args. Components import ops, not the db.
- `useDb()` returns the provider's db (throws outside `<DbProvider>`).
- Call ops from event handlers or `useEffect`, **never during render** (a render-time op would write during render). Subscribers can't call ops either.
- Pass IDs (not rows) to child components and let each child `useQuery(table.get(id))`; this keeps re-renders narrow.
- Query results are unordered: sort with `useMemo`.
- Rows are frozen: copy before sorting (`[...rows].sort(...)`).
- Create the db once at module scope (or once per app instance), not inside a component.

## Introspection (devtools)

`createDb({ introspect: true })` adds read-only tables that are queried like any other (`useQuery(sys.tasks.byStatus.statusEq("running"))`): `sys.tasks` (indexes `byEffect: [effect, status]`, `byStatus`), `sys.effects`, `sys.tables` (index `byKind`). Reading `sys.*` without `introspect` throws. Handy for debugging stuck effects: look for tasks with `status: "failed"` or an unexpected `abortReason`.

## Testing

- There is no `flush()`: a batch is pending only between a commit and its microtask, so **`await Promise.resolve()` once** lets aggregates/subscribers run. For effect tasks, wait a macrotask (`await new Promise(r => setTimeout(r))`) or use a deferred promise.
- `db.read(aggregate.get(id))` first brings that aggregate up to date, so reads in tests don't need a flush.
- Build a fresh db per test from the same features and call `db.dispose()` in `afterEach` so tasks and subscriptions don't leak.
- Component tests: Vitest with `environment: "jsdom"`, `@testing-library/react`, wrap in `<DbProvider db={db}>`, and wrap ops that trigger updates in `await act(async () => { ... })`.

## Common mistakes

| Mistake | What happens |
| --- | --- |
| Mutating a row or nested value | Assigning to a top-level field throws (rows are frozen); nested objects aren't frozen, but mutating them is unsupported |
| `.default()` / `.transform()` in a table schema | The first validated write to that table throws (output differs from input); not caught at `createDb` |
| Indexing a non-primitive column | Type error |
| Forgetting to put a table or aggregate in a feature's `tables` | Ops touching it throw at run time; `createDb` throws if an aggregate/effect input is missing |
| Calling an op from `compute`, `watch`, or a subscriber | Throws |
| `async` op | Type error; throws at runtime |
| Expecting rows in insertion order | Order is unspecified |
| Reading an aggregate inside the op that just wrote its inputs | Sees pre-op state; return a key and read after the op |
| Ignoring `signal` in a task | Task can't be cancelled promptly; the engine still blocks its writes once aborted |
| A task updating its own row without `rerunOn` | Restarts itself; capped after 100 flushes, then the effect is disabled |
