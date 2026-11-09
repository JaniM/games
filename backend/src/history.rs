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
//! Games that were played before the history existed have none: only their last state was
//! kept. Asking for one gives an empty list, as it does for a game that has not started.
//!
//! [`Game::record`]: crate::game::Game::record

use axum::{
    Json,
    extract::{Path, State},
};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgConnection, PgPool};

use crate::{auth::AuthUser, error::ApiError, game_id::GameId, room::Rooms};

/// Keeps `record` as the state of the game at `revision`, as part of the transaction `tx`
/// that gives the game that revision. The error is for the log.
pub async fn insert(
    tx: &mut PgConnection,
    game_id: &GameId,
    revision: i64,
    state_version: i32,
    record: &Value,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO game_history (game_id, revision, state_version, state)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(game_id)
    .bind(revision)
    .bind(state_version)
    .bind(record)
    .execute(tx)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
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

/// One row of the query that reads a history, in the order of its columns: revision, state
/// version and state.
type StoredPosition = (i64, i32, Value);

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

    let rows: Vec<StoredPosition> = sqlx::query_as(
        "SELECT revision, state_version, state
         FROM game_history
         WHERE game_id = $1
         ORDER BY revision",
    )
    .bind(&game_id)
    .fetch_all(&pool)
    .await
    .map_err(ApiError::database("could not read a game's history"))?;

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
             VALUES ($1, $2, $3, $4::jsonb)",
        )
        .bind(game)
        .bind(revision)
        .bind(version)
        .bind(state)
        .execute(pool)
        .await
        .unwrap();
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
