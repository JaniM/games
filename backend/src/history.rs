//! A game's history: every state it has been in, so that a game can be stepped through
//! afterwards, by its players and by anyone who watches.
//!
//! The `games` table holds only the newest state. The history keeps the rest in
//! `game_history`, one row per revision that gave the game a state, oldest first by
//! revision:
//!
//! - the revision at which the last seat is taken, which starts the game;
//! - every action the rules accept, a player's or the bot's, and an undo is one like any other;
//! - a game that is made already started (a game for one player, a game against the bot, the
//!   game of a rematch), at revision 0.
//!
//! A change that leaves the state as it was (a rematch asked for or answered) adds no row,
//! so the revisions of a history rise but have gaps. A refused action adds none either.
//!
//! The row is written in the same transaction as the change to `games` (see [`insert`], used
//! by `room`), so a state the clients saw is always in the history and a state that was never
//! saved is not.
//!
//! What a row holds is the game's *record* of the state (see [`Game::record`]), which may
//! leave out what can be worked out again. Rows keep the layout version they were written
//! with, as `games` does, and are brought up to date when they are read.
//!
//! The record is kept as `json` text, not `jsonb`: nothing looks inside a history row, and
//! `jsonb` is about three times the size for a state made of small numbers. A history has a
//! row for every step of a game, so what a row costs is what a game costs.
//!
//! # States and deltas
//!
//! A step of a game changes a few numbers of a state that has dozens, so a row holds either the
//! state or, where that is shorter, only what changed since the row before it (see [`delta`]).
//! A row has exactly one of the columns `state` and `delta`. A history is only ever read whole,
//! oldest first, so [`unfold`] gives every row its state by applying the deltas one after the
//! other.
//!
//! The room that writes a row knows the game's last record only if it wrote that record itself.
//! A room that has just loaded a game does not, so its first row is a state. That also keeps the
//! layout version from changing in the middle of a run of deltas: a new version of the server
//! starts new rooms. A delta is of the same layout version as the row it applies to, which
//! [`unfold`] checks, and once a row is a state it is brought up to date on its own.
//!
//! Games that were played before the history existed have none: only their last state was
//! kept. Asking for one gives an empty list, as it does for a game that has not started.
//!
//! [`Game::record`]: crate::game::Game::record
//! [`delta`]: crate::delta

use axum::{
    Json,
    extract::{Path, State},
};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgConnection, PgPool};

use crate::{auth::AuthUser, delta, error::ApiError, game_id::GameId, room::Rooms};

/// What a history row holds, as the text of a `json` column.
#[derive(Debug, PartialEq, Eq)]
enum Stored {
    State(String),
    Delta(String),
}

impl Stored {
    /// The shorter of `record` and what turns `previous` into it. `previous` is the record of
    /// the row before, and is none when the caller doesn't know it, which gives the state.
    fn of(previous: Option<&Value>, record: &Value) -> Self {
        let state = record.to_string();
        match previous.map(|previous| delta::diff(previous, record).to_string()) {
            Some(delta) if delta.len() < state.len() => Self::Delta(delta),
            _ => Self::State(state),
        }
    }
}

/// Keeps `record` as the state of the game at `revision`, as part of the transaction `tx`
/// that gives the game that revision. The error is for the log.
///
/// `previous` is the record of the game's latest row, if the caller wrote it and so knows it.
/// The row then holds only what changed since, if that is shorter. Without it, the row holds
/// the state (see the notes on states and deltas above).
///
/// The columns are `json`, which keeps the text it is given. It is bound as text and cast,
/// rather than as a [`Value`], because a bound `Value` is sent as `jsonb` and comes back out of
/// that cast with spaces added, a quarter longer than what `serde_json` writes.
pub async fn insert(
    tx: &mut PgConnection,
    game_id: &GameId,
    revision: i64,
    state_version: i32,
    previous: Option<&Value>,
    record: &Value,
) -> Result<(), String> {
    let (state, delta) = match Stored::of(previous, record) {
        Stored::State(state) => (Some(state), None),
        Stored::Delta(delta) => (None, Some(delta)),
    };
    sqlx::query(
        "INSERT INTO game_history (game_id, revision, state_version, state, delta)
         VALUES ($1, $2, $3, $4::json, $5::json)",
    )
    .bind(game_id)
    .bind(revision)
    .bind(state_version)
    .bind(state)
    .bind(delta)
    .execute(tx)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

/// One row of the query that reads a history, in the order of its columns: revision, state
/// version, state and delta. Exactly one of the last two is there.
pub type StoredRow = (i64, i32, Option<Value>, Option<Value>);

/// The state of every row of a history, as `(revision, state version, state)`, in the order of
/// the rows, which must be that of their revisions. A state starts over from itself, and a delta
/// is applied to the state of the row before. The error says what is wrong with the rows, for
/// the log: a history with a row missing or wrong would show moves that did not happen, so
/// there is no reading around one.
pub fn unfold(rows: Vec<StoredRow>) -> Result<Vec<(i64, i32, Value)>, String> {
    let mut states: Vec<(i64, i32, Value)> = Vec::with_capacity(rows.len());
    for (revision, version, state, delta) in rows {
        let state = match (state, delta) {
            (Some(state), None) => state,
            (None, Some(delta)) => {
                let Some((_, before, previous)) = states.last() else {
                    return Err(format!("the first row, at revision {revision}, is a delta"));
                };
                if *before != version {
                    return Err(format!(
                        "the delta at revision {revision} is of layout {version}, \
                         the row before it of {before}"
                    ));
                }
                let mut state = previous.clone();
                delta::apply(&mut state, &delta)
                    .map_err(|err| format!("the delta at revision {revision}: {err}"))?;
                state
            }
            _ => {
                return Err(format!(
                    "the row at revision {revision} has both a state and a delta, or neither"
                ));
            }
        };
        states.push((revision, version, state));
    }
    Ok(states)
}

/// What `GET /api/games/{id}/history` answers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    game_id: GameId,
    kind: &'static str,
    /// The layout version of every `state` below: the server's current one, whichever version
    /// a row was written with.
    state_version: u32,
    /// Oldest first.
    positions: Vec<Position>,
}

/// The game at one revision.
#[derive(Serialize)]
pub struct Position {
    /// The `revision` that a snapshot of the game had while it was in this state.
    revision: i64,
    /// The game's record of the state (see [`crate::game::Game::record`]).
    state: Value,
}

/// `GET /api/games/{id}/history`: the states the game has been in, oldest first, as
/// `{ "gameId": "…", "kind": "…", "stateVersion": 1, "positions": [{ "revision": 2,
/// "state": { … } }, …] }`. A client that is watching the game gets the same revisions in its
/// snapshots, so it can tell which position the game is in now.
///
/// As on the game's WebSocket, **anyone with a token who knows the game's id may read it**,
/// whether or not they have a seat. `positions` is empty for a game that has not started and
/// for one played before the history existed. Answers 404 for an unknown game.
pub async fn game_history(
    _user: AuthUser,
    State(pool): State<PgPool>,
    State(rooms): State<Rooms>,
    Path(game_id): Path<GameId>,
) -> Result<Json<History>, ApiError> {
    let kind: Option<String> = sqlx::query_scalar("SELECT kind FROM games WHERE id = $1")
        .bind(&game_id)
        .fetch_optional(&pool)
        .await
        .map_err(ApiError::database("could not look up a game"))?;
    let kind = kind.ok_or(ApiError::NotFound)?;
    let Some(engine) = rooms.games().get(&kind) else {
        tracing::error!(game = %game_id, kind, "stored game of unknown kind");
        return Err(ApiError::Internal);
    };

    let rows: Vec<StoredRow> = sqlx::query_as(
        "SELECT revision, state_version, state, delta
         FROM game_history
         WHERE game_id = $1
         ORDER BY revision",
    )
    .bind(&game_id)
    .fetch_all(&pool)
    .await
    .map_err(ApiError::database("could not read a game's history"))?;

    let rows = unfold(rows).map_err(|err| {
        tracing::error!(%err, game = %game_id, "could not read a game's history");
        ApiError::Internal
    })?;

    let current = engine.state_version();
    let mut positions = Vec::with_capacity(rows.len());
    for (revision, stored_version, state) in rows {
        let state = if stored_version as u32 == current {
            state
        } else {
            // A row from an older layout goes through the game, as a stored game does when a
            // room loads it. One that can't be read is our fault and fails the whole history,
            // because a history with a hole in it would show moves that did not happen.
            engine
                .load(stored_version as u32, state)
                .and_then(|live| live.to_record())
                .map_err(|err| {
                    tracing::error!(%err, game = %game_id, revision, "could not read a state of a game's history");
                    ApiError::Internal
                })?
        };
        positions.push(Position { revision, state });
    }
    Ok(Json(History {
        game_id,
        kind: engine.kind(),
        state_version: current,
        positions,
    }))
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::json;

    use super::*;
    use crate::{
        game::Games,
        test_util::{Client, Reply, Tally, TallyV2, TestApp},
    };

    /// A row that holds a state, as `unfold` reads it.
    fn state_row(revision: i64, version: i32, state: Value) -> StoredRow {
        (revision, version, Some(state), None)
    }

    /// A row that holds a delta.
    fn delta_row(revision: i64, version: i32, delta: Value) -> StoredRow {
        (revision, version, None, Some(delta))
    }

    #[test]
    fn a_row_holds_the_delta_when_it_is_shorter_and_the_state_when_it_is_not() {
        let old = json!({ "cells": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "turn": 0 });
        let new = json!({ "cells": [0, 0, 0, 1, 0, 0, 0, 0, 0, 0], "turn": 1 });
        assert_eq!(
            Stored::of(Some(&old), &new),
            Stored::Delta(r#"[[["cells",3],1],[["turn"],1]]"#.to_owned())
        );

        // Two changes are longer than a state of two small numbers.
        let (old, new) = (
            json!({ "total": 0, "turn": 0 }),
            json!({ "total": 5, "turn": 1 }),
        );
        assert_eq!(
            Stored::of(Some(&old), &new),
            Stored::State(r#"{"total":5,"turn":1}"#.to_owned())
        );

        // With no row before to build on, there is only the state.
        assert_eq!(
            Stored::of(None, &new),
            Stored::State(r#"{"total":5,"turn":1}"#.to_owned())
        );
    }

    #[test]
    fn unfolding_applies_each_delta_to_the_state_before_it() {
        let rows = vec![
            state_row(1, 1, json!({ "a": [1, 2, 3, 4, 5, 6], "b": 0 })),
            delta_row(2, 1, json!([[["a", 0], 9]])),
            delta_row(4, 1, json!([[["b"], 1], [["a", 5], 8]])),
            state_row(5, 1, json!({ "a": [0, 0, 0, 0, 0, 0], "b": 7 })),
            delta_row(6, 1, json!([[["b"], 8]])),
        ];

        assert_eq!(
            unfold(rows).unwrap(),
            [
                (1, 1, json!({ "a": [1, 2, 3, 4, 5, 6], "b": 0 })),
                (2, 1, json!({ "a": [9, 2, 3, 4, 5, 6], "b": 0 })),
                (4, 1, json!({ "a": [9, 2, 3, 4, 5, 8], "b": 1 })),
                (5, 1, json!({ "a": [0, 0, 0, 0, 0, 0], "b": 7 })),
                (6, 1, json!({ "a": [0, 0, 0, 0, 0, 0], "b": 8 })),
            ]
        );
    }

    #[test]
    fn a_history_that_cannot_be_unfolded_is_refused_not_guessed_at() {
        let state = || state_row(1, 1, json!({ "a": [1, 2], "b": 0 }));
        for (what, rows) in [
            ("a delta first", vec![delta_row(1, 1, json!([]))]),
            (
                "a delta of another layout than the row before",
                vec![state(), delta_row(2, 2, json!([]))],
            ),
            (
                "a delta that does not fit",
                vec![state(), delta_row(2, 1, json!([[["c", "d"], 1]]))],
            ),
            (
                "a delta that is not a delta",
                vec![state(), delta_row(2, 1, json!({}))],
            ),
            (
                "a row with both",
                vec![(1, 1, Some(json!({})), Some(json!([])))],
            ),
            ("a row with neither", vec![(1, 1, None, None)]),
        ] {
            assert!(unfold(rows).is_err(), "{what} was accepted");
        }
    }

    fn app(pool: PgPool) -> TestApp {
        TestApp::new(pool, Games::default().with::<Tally>())
    }

    /// The `(revision, state)` of every position in a reply.
    fn positions(reply: &Reply) -> Vec<(i64, serde_json::Value)> {
        reply.json["positions"]
            .as_array()
            .expect("the reply lists positions")
            .iter()
            .map(|p| (p["revision"].as_i64().unwrap(), p["state"].clone()))
            .collect()
    }

    /// A tally game between two new users that has started, and the users' tokens by seat.
    async fn started(app: &TestApp) -> (String, [String; 2]) {
        let (_, first) = app.register_user().await;
        let (_, second) = app.register_user().await;
        let game = app.create_game(&first, "tally").await;
        app.join_game(&second, &game).await;
        (game, [first, second])
    }

    #[sqlx::test]
    async fn reading_a_history_needs_a_known_token(pool: PgPool) {
        let app = app(pool);
        let (game, [first, _]) = started(&app).await;

        let nobody = app.history(None, &game).await;
        let stranger = app.history(Some("not-a-token"), &game).await;
        let player = app.history(Some(&first), &game).await;

        assert_eq!(nobody.status, StatusCode::UNAUTHORIZED);
        assert_eq!(stranger.status, StatusCode::UNAUTHORIZED);
        assert_eq!(player.status, StatusCode::OK);
    }

    #[sqlx::test]
    async fn a_game_that_does_not_exist_has_no_history_to_read(pool: PgPool) {
        let app = app(pool);
        let (_, token) = app.register_user().await;

        let reply = app.history(Some(&token), "abcdefghijkm").await;

        assert_eq!(reply.status, StatusCode::NOT_FOUND);
    }

    #[sqlx::test]
    async fn a_game_that_has_not_started_has_an_empty_history(pool: PgPool) {
        let app = app(pool);
        let (_, token) = app.register_user().await;
        let game = app.create_game(&token, "tally").await;

        let reply = app.history(Some(&token), &game).await;

        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            reply.json,
            json!({ "gameId": game, "kind": "tally", "stateVersion": 1, "positions": [] })
        );
    }

    #[sqlx::test]
    async fn the_history_lists_the_states_of_a_game_oldest_first(pool: PgPool) {
        let app = app(pool);
        let (game, [first, second]) = started(&app).await;
        let server = app.serve().await;
        let mut ada = Client::sign_in(&server, &game, &first).await;
        let mut grace = Client::sign_in(&server, &game, &second).await;
        ada.next().await;
        grace.next().await;
        ada.act(json!({ "type": "add", "amount": 5 })).await;
        assert_eq!(ada.next().await["revision"], 2);
        assert_eq!(grace.next().await["revision"], 2);
        grace.act(json!({ "type": "add", "amount": 2 })).await;
        assert_eq!(grace.next().await["revision"], 3);

        let reply = app.history(Some(&first), &game).await;

        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json["gameId"], game.as_str());
        assert_eq!(reply.json["kind"], "tally");
        assert_eq!(reply.json["stateVersion"], 1);
        assert_eq!(
            positions(&reply),
            [
                (1, json!({ "total": 0, "turn": 0 })),
                (2, json!({ "total": 5, "turn": 1 })),
                (3, json!({ "total": 7, "turn": 0 })),
            ]
        );
    }

    #[sqlx::test]
    async fn anyone_who_knows_the_game_can_read_its_history_not_only_its_players(pool: PgPool) {
        let app = app(pool);
        let (game, _) = started(&app).await;
        let (_, watcher) = app.register_user().await;

        let reply = app.history(Some(&watcher), &game).await;

        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(positions(&reply), [(1, json!({ "total": 0, "turn": 0 }))]);
    }

    /// An app whose game has moved on to layout 2 of `tally`, and a game it made, started.
    async fn upgraded(pool: &PgPool) -> (TestApp, String, String) {
        let app = TestApp::new(pool.clone(), Games::default().with::<TallyV2>());
        let (game, [first, _]) = started(&app).await;
        (app, game, first)
    }

    async fn store(pool: &PgPool, game: &str, revision: i64, version: i32, state: &str) {
        sqlx::query(
            "INSERT INTO game_history (game_id, revision, state_version, state)
             VALUES ($1, $2, $3, $4::json)",
        )
        .bind(game)
        .bind(revision)
        .bind(version)
        .bind(state)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn store_delta(pool: &PgPool, game: &str, revision: i64, version: i32, delta: &str) {
        sqlx::query(
            "INSERT INTO game_history (game_id, revision, state_version, delta)
             VALUES ($1, $2, $3, $4::json)",
        )
        .bind(game)
        .bind(revision)
        .bind(version)
        .bind(delta)
        .execute(pool)
        .await
        .unwrap();
    }

    #[sqlx::test]
    async fn the_history_gives_the_state_a_delta_leads_to(pool: PgPool) {
        let app = app(pool.clone());
        let (game, [first, _]) = started(&app).await;
        store_delta(&pool, &game, 2, 1, r#"[[["total"],5],[["turn"],1]]"#).await;
        store_delta(&pool, &game, 3, 1, r#"[[["total"],7],[["turn"],0]]"#).await;

        let reply = app.history(Some(&first), &game).await;

        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(
            positions(&reply),
            [
                (1, json!({ "total": 0, "turn": 0 })),
                (2, json!({ "total": 5, "turn": 1 })),
                (3, json!({ "total": 7, "turn": 0 })),
            ]
        );
    }

    #[sqlx::test]
    async fn deltas_written_under_an_older_layout_are_brought_up_to_date_when_read(pool: PgPool) {
        // An older server wrote the game, and a row of it as a delta of layout 1.
        let older = app(pool.clone());
        let (game, [first, _]) = started(&older).await;
        store_delta(&pool, &game, 2, 1, r#"[[["total"],5],[["turn"],1]]"#).await;

        // A newer server reads it. Every row is applied in the layout it was written in, and
        // then upgraded.
        let (newer, _, _) = upgraded(&pool).await;
        let reply = newer.history(Some(&first), &game).await;

        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json["stateVersion"], 2);
        assert_eq!(
            positions(&reply),
            [
                (1, json!({ "sum": 0, "turn": 0 })),
                (2, json!({ "sum": 5, "turn": 1 })),
            ]
        );
    }

    #[sqlx::test]
    async fn a_delta_that_does_not_fit_fails_the_whole_history(pool: PgPool) {
        let app = app(pool.clone());
        let (game, [first, _]) = started(&app).await;
        store_delta(&pool, &game, 2, 1, r#"[[["nothing", "here"], 5]]"#).await;

        let reply = app.history(Some(&first), &game).await;

        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[sqlx::test]
    async fn a_row_holds_a_state_or_a_delta_never_both_or_neither(pool: PgPool) {
        let app = app(pool.clone());
        let (game, _) = started(&app).await;
        let insert = |revision: i64, state: Option<&'static str>, delta: Option<&'static str>| {
            let (pool, game) = (pool.clone(), game.clone());
            async move {
                sqlx::query(
                    "INSERT INTO game_history (game_id, revision, state_version, state, delta)
                     VALUES ($1, $2, 1, $3::json, $4::json)",
                )
                .bind(game)
                .bind(revision)
                .bind(state)
                .bind(delta)
                .execute(&pool)
                .await
            }
        };

        assert!(insert(2, Some("{}"), Some("[]")).await.is_err());
        assert!(insert(3, None, None).await.is_err());
        assert!(insert(4, None, Some("[]")).await.is_ok());
        assert!(insert(5, Some("{}"), None).await.is_ok());
    }

    /// Plays long backgammon against the bot for `turns` turns by always taking the first step
    /// the server offers, and gives the snapshots seen on the way.
    async fn play_against_the_bot(app: &TestApp, turns: u64) -> (String, String, Vec<Value>) {
        let server = app.serve().await;
        let (_, token) = app.register_user().await;
        let created = app.create_bot_game(&token, "long-backgammon").await;
        let game = created.json["gameId"].as_str().unwrap().to_owned();
        let mut client = Client::sign_in(&server, &game, &token).await;
        let mut seen = Vec::new();
        let mut snapshot = client.next().await;
        for _ in 0..2_000 {
            seen.push(snapshot.clone());
            let state = &snapshot["state"];
            if state["turns"][0].as_u64() >= Some(turns) || state["phase"]["type"] == "over" {
                break;
            }
            if state["turn"] == 0 {
                match state["phase"]["type"].as_str().unwrap() {
                    "roll" => client.act(json!({ "type": "roll" })).await,
                    _ => {
                        let step = &state["legal"][0];
                        let action =
                            json!({ "type": "move", "from": step["from"], "die": step["die"] });
                        client.act(action).await;
                    }
                }
            }
            snapshot = client.next().await;
        }
        (game, token, seen)
    }

    #[sqlx::test]
    async fn the_history_of_a_real_game_is_what_the_players_saw_and_much_smaller(pool: PgPool) {
        // The real games, not a stand-in: long backgammon is what the deltas are for.
        let app = TestApp::new(pool.clone(), crate::game::registry());
        let (game, token, seen) = play_against_the_bot(&app, 6).await;

        let reply = app.history(Some(&token), &game).await;

        assert_eq!(reply.status, StatusCode::OK);
        let history = positions(&reply);
        assert!(history.len() > 30, "only {} states", history.len());
        // Every snapshot a player was shown is in the history, as the position without what
        // can be worked out from it (see `Game::record`).
        let mut compared = 0;
        for snapshot in &seen {
            let revision = snapshot["revision"].as_i64().unwrap();
            let Some((_, state)) = history.iter().find(|(at, _)| *at == revision) else {
                continue;
            };
            let mut shown = snapshot["state"].clone();
            shown.as_object_mut().unwrap().remove("legal");
            shown.as_object_mut().unwrap().remove("combos");
            assert_eq!(state, &shown, "revision {revision}");
            compared += 1;
        }
        assert!(compared > 20, "only compared {compared} snapshots");
        // The rows are deltas but for two, and together less than half the length of the states
        // they stand for (a whole game is nearer two fifths; dice make it vary). The two are the game's first state, which it was made with, and the
        // first that its room saved: the room had just loaded the game, so it had no row of its
        // own to build on.
        let (rows, deltas, stored): (i64, i64, i64) = sqlx::query_as(
            "SELECT count(*), count(delta), sum(length(coalesce(state, delta)::text))::bigint
             FROM game_history WHERE game_id = $1",
        )
        .bind(&game)
        .fetch_one(&pool)
        .await
        .unwrap();
        let whole: usize = history
            .iter()
            .map(|(_, state)| state.to_string().len())
            .sum();
        assert_eq!(rows as usize, history.len());
        assert_eq!(deltas, rows - 2);
        assert!(
            (stored as usize) * 2 < whole,
            "{stored} bytes stored for {whole} bytes of states"
        );
    }

    #[sqlx::test]
    async fn states_of_an_older_layout_are_brought_up_to_date_when_read(pool: PgPool) {
        let (app, game, token) = upgraded(&pool).await;
        // Stored by a server that wrote layout 1, before the one that wrote the row at
        // revision 1. Insertion order is no matter: the revisions are what order them.
        store(&pool, &game, 0, 1, r#"{ "total": 3, "turn": 1 }"#).await;

        let reply = app.history(Some(&token), &game).await;

        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json["stateVersion"], 2);
        assert_eq!(
            positions(&reply),
            [
                (0, json!({ "sum": 3, "turn": 1 })),
                (1, json!({ "sum": 0, "turn": 0 })),
            ]
        );
    }

    #[sqlx::test]
    async fn a_state_the_game_cannot_read_fails_the_whole_history(pool: PgPool) {
        let (app, game, token) = upgraded(&pool).await;
        store(&pool, &game, 0, 1, r#"{ "total": "lots" }"#).await;

        let reply = app.history(Some(&token), &game).await;

        // A history with a hole in it would show moves that did not happen.
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[sqlx::test]
    async fn a_state_from_a_newer_server_fails_the_history(pool: PgPool) {
        let (app, game, token) = upgraded(&pool).await;
        store(&pool, &game, 0, 3, r#"{ "sum": 3, "turn": 1 }"#).await;

        let reply = app.history(Some(&token), &game).await;

        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[sqlx::test]
    async fn a_game_of_a_kind_the_server_does_not_offer_has_no_history_to_read(pool: PgPool) {
        let (game, [first, _]) = started(&app(pool.clone())).await;
        let without_games = TestApp::new(pool, Games::default());

        let reply = without_games.history(Some(&first), &game).await;

        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    }
}
