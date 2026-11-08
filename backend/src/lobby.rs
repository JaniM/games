//! Creating, joining and listing games over HTTP. Playing happens on the game's
//! WebSocket (see `socket`).
//!
//! A game's id is its invite: whoever has it can join while a seat is free. Ids are
//! random, so they can't be found by guessing.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    error::ApiError,
    room::{RoomError, Rooms},
};

/// The most games `GET /api/games` returns, newest activity first.
const LIST_LIMIT: i64 = 100;

#[derive(Deserialize)]
pub struct NewGame {
    kind: String,
}

/// Where a user sits in a game.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Seat {
    game_id: Uuid,
    seat: usize,
}

/// `POST /api/games` with `{ "kind": "..." }`: creates a game, with the user in seat 0,
/// and loads it. Answers 422 for a kind the server doesn't offer.
pub async fn create_game(
    AuthUser(user): AuthUser,
    State(rooms): State<Rooms>,
    Json(body): Json<NewGame>,
) -> Result<(StatusCode, Json<Seat>), ApiError> {
    let engine = rooms
        .games()
        .get(&body.kind)
        .ok_or(ApiError::Invalid("unknown kind of game"))?;
    let game_id = rooms.create(engine, user).await.map_err(api_error)?;
    Ok((StatusCode::CREATED, Json(Seat { game_id, seat: 0 })))
}

/// `POST /api/games/{id}/join`: takes the next free seat, which starts the game if it
/// was the last. Joining a game the user is in is fine and returns their seat.
/// Answers 404 for an unknown game and 409 if it is full.
pub async fn join_game(
    AuthUser(user): AuthUser,
    State(rooms): State<Rooms>,
    Path(game_id): Path<Uuid>,
) -> Result<Json<Seat>, ApiError> {
    let seat = rooms.join(game_id, user).await.map_err(api_error)?;
    Ok(Json(Seat { game_id, seat }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Games {
    games: Vec<Listed>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    game_id: Uuid,
    kind: String,
    /// The user's seat.
    seat: i16,
    /// How many seats are taken.
    joined: i64,
    /// False while the game waits for more players.
    started: bool,
    /// When the game last changed, in milliseconds since the epoch.
    updated_at: i64,
}

/// `GET /api/games`: the games the user is in, most recently changed first, at most 100.
/// Read from the database, so it also lists games that aren't in memory.
pub async fn list_games(
    AuthUser(user): AuthUser,
    State(pool): State<PgPool>,
) -> Result<Json<Games>, ApiError> {
    let rows: Vec<(Uuid, String, i16, i64, bool, i64)> = sqlx::query_as(
        "SELECT g.id,
                g.kind,
                p.seat,
                (SELECT count(*) FROM game_players WHERE game_id = g.id),
                g.state IS NOT NULL,
                (extract(epoch FROM g.updated_at) * 1000)::bigint
         FROM game_players p
         JOIN games g ON g.id = p.game_id
         WHERE p.user_id = $1
         ORDER BY g.updated_at DESC, g.id
         LIMIT $2",
    )
    .bind(user)
    .bind(LIST_LIMIT)
    .fetch_all(&pool)
    .await
    .map_err(ApiError::database("could not list a user's games"))?;
    let games = rows
        .into_iter()
        .map(
            |(game_id, kind, seat, joined, started, updated_at)| Listed {
                game_id,
                kind,
                seat,
                joined,
                started,
                updated_at,
            },
        )
        .collect();
    Ok(Json(Games { games }))
}

fn api_error(err: RoomError) -> ApiError {
    match err {
        RoomError::NotFound => ApiError::NotFound,
        RoomError::Full => ApiError::Conflict("the game is full"),
        // Creating and joining don't produce the others. If one shows up, it is our bug.
        RoomError::NotAPlayer
        | RoomError::NotStarted
        | RoomError::Rejected(_)
        | RoomError::Internal
        | RoomError::Gone => ApiError::Internal,
    }
}

#[cfg(test)]
mod tests {
    use axum::http::Method;
    use serde_json::{Value, json};

    use super::*;
    use crate::{
        game,
        test_util::{Solo, Tally, TestApp, bearer},
    };

    fn app(pool: PgPool) -> TestApp {
        TestApp::new(pool, game::Games::default().with::<Tally>().with::<Solo>())
    }

    /// What the database holds for a game: revision, state version, state, players by seat.
    async fn stored(pool: &PgPool, game_id: &str) -> (i64, i32, Option<Value>, Vec<String>) {
        let id: Uuid = game_id.parse().unwrap();
        let (revision, version, state): (i64, i32, Option<Value>) =
            sqlx::query_as("SELECT revision, state_version, state FROM games WHERE id = $1")
                .bind(id)
                .fetch_one(pool)
                .await
                .unwrap();
        let players: Vec<Uuid> =
            sqlx::query_scalar("SELECT user_id FROM game_players WHERE game_id = $1 ORDER BY seat")
                .bind(id)
                .fetch_all(pool)
                .await
                .unwrap();
        let players = players.iter().map(Uuid::to_string).collect();
        (revision, version, state, players)
    }

    async fn list(app: &TestApp, token: &str) -> Value {
        let reply = app
            .send(Method::GET, "/api/games", Some(&bearer(token)), None)
            .await;
        assert_eq!(reply.status, StatusCode::OK);
        reply.json["games"].clone()
    }

    #[sqlx::test]
    async fn a_game_is_created_with_its_creator_in_seat_zero(pool: PgPool) {
        let app = app(pool.clone());
        let (user_id, token) = app.register_user().await;

        let reply = app
            .send(
                Method::POST,
                "/api/games",
                Some(&bearer(&token)),
                Some(json!({ "kind": "tally" })),
            )
            .await;

        assert_eq!(reply.status, StatusCode::CREATED);
        assert_eq!(reply.json["seat"], 0);
        let game_id = reply.json["gameId"].as_str().unwrap();
        // The game waits for a second player, so it has no state yet.
        assert_eq!(stored(&pool, game_id).await, (0, 1, None, vec![user_id]));
    }

    #[sqlx::test]
    async fn game_ids_are_random_uuids(pool: PgPool) {
        let app = app(pool);
        let (_, token) = app.register_user().await;

        let first = app.create_game(&token, "tally").await;
        let second = app.create_game(&token, "tally").await;

        assert_ne!(first, second);
        for id in [first, second] {
            let id: Uuid = id.parse().unwrap();
            assert_eq!(id.get_version_num(), 4, "{id} is not a random uuid");
        }
    }

    #[sqlx::test]
    async fn creating_a_game_needs_a_known_token(pool: PgPool) {
        let app = app(pool);

        for authorization in [None, Some("Bearer unknown")] {
            let reply = app
                .send(
                    Method::POST,
                    "/api/games",
                    authorization,
                    Some(json!({ "kind": "tally" })),
                )
                .await;
            assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        }
    }

    #[sqlx::test]
    async fn a_kind_the_server_does_not_offer_creates_nothing(pool: PgPool) {
        let app = app(pool.clone());
        let (_, token) = app.register_user().await;

        let reply = app
            .send(
                Method::POST,
                "/api/games",
                Some(&bearer(&token)),
                Some(json!({ "kind": "chess" })),
            )
            .await;

        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        let games: i64 = sqlx::query_scalar("SELECT count(*) FROM games")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(games, 0);
    }

    #[sqlx::test]
    async fn a_game_for_one_player_starts_when_it_is_created(pool: PgPool) {
        let app = app(pool.clone());
        let (_, token) = app.register_user().await;

        let game_id = app.create_game(&token, "solo").await;

        let (revision, _, state, _) = stored(&pool, &game_id).await;
        assert_eq!((revision, state), (0, Some(json!({ "count": 0 }))));
    }

    #[sqlx::test]
    async fn the_last_player_to_join_starts_the_game(pool: PgPool) {
        let app = app(pool.clone());
        let (creator, creator_token) = app.register_user().await;
        let (joiner, joiner_token) = app.register_user().await;
        let game_id = app.create_game(&creator_token, "tally").await;

        let reply = app.join_game(&joiner_token, &game_id).await;

        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json, json!({ "gameId": game_id, "seat": 1 }));
        assert_eq!(
            stored(&pool, &game_id).await,
            (
                1,
                1,
                Some(json!({ "total": 0, "turn": 0 })),
                vec![creator, joiner]
            )
        );
    }

    #[sqlx::test]
    async fn joining_a_game_you_are_in_changes_nothing(pool: PgPool) {
        let app = app(pool.clone());
        let (_, creator_token) = app.register_user().await;
        let (_, joiner_token) = app.register_user().await;
        let game_id = app.create_game(&creator_token, "tally").await;
        app.join_game(&joiner_token, &game_id).await;
        let before = stored(&pool, &game_id).await;

        let creator = app.join_game(&creator_token, &game_id).await;
        let joiner = app.join_game(&joiner_token, &game_id).await;

        assert_eq!(creator.json["seat"], 0);
        assert_eq!(joiner.json["seat"], 1);
        assert_eq!(stored(&pool, &game_id).await, before);
    }

    #[sqlx::test]
    async fn a_full_game_turns_the_next_player_away(pool: PgPool) {
        let app = app(pool.clone());
        let (_, creator_token) = app.register_user().await;
        let (_, joiner_token) = app.register_user().await;
        let (_, late_token) = app.register_user().await;
        let game_id = app.create_game(&creator_token, "tally").await;
        app.join_game(&joiner_token, &game_id).await;
        let before = stored(&pool, &game_id).await;

        let reply = app.join_game(&late_token, &game_id).await;

        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(stored(&pool, &game_id).await, before);
    }

    #[sqlx::test]
    async fn joining_needs_a_known_token_and_a_known_game(pool: PgPool) {
        let app = app(pool);
        let (_, token) = app.register_user().await;
        let game_id = app.create_game(&token, "tally").await;
        let (_, other_token) = app.register_user().await;

        let no_token = app
            .send(
                Method::POST,
                &format!("/api/games/{game_id}/join"),
                None,
                None,
            )
            .await;
        assert_eq!(no_token.status, StatusCode::UNAUTHORIZED);

        let unknown_game = app
            .join_game(&other_token, &Uuid::from_u128(1).to_string())
            .await;
        assert_eq!(unknown_game.status, StatusCode::NOT_FOUND);

        let not_an_id = app.join_game(&other_token, "tally").await;
        assert!(not_an_id.status.is_client_error(), "{}", not_an_id.status);
    }

    #[sqlx::test]
    async fn listing_shows_the_games_you_are_in_newest_first(pool: PgPool) {
        let app = app(pool);
        let (_, ada) = app.register_user().await;
        let (_, grace) = app.register_user().await;
        let waiting = app.create_game(&ada, "tally").await;
        let started = app.create_game(&grace, "tally").await;
        app.join_game(&ada, &started).await;
        let solo = app.create_game(&ada, "solo").await;

        let games = list(&app, &ada).await;

        let games = games.as_array().unwrap();
        let ids: Vec<_> = games
            .iter()
            .map(|g| g["gameId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, [solo.as_str(), started.as_str(), waiting.as_str()]);
        let summary = |g: &Value| {
            (
                g["kind"].as_str().unwrap().to_owned(),
                g["seat"].as_i64().unwrap(),
                g["joined"].as_i64().unwrap(),
                g["started"].as_bool().unwrap(),
            )
        };
        assert_eq!(summary(&games[0]), ("solo".to_owned(), 0, 1, true));
        assert_eq!(summary(&games[1]), ("tally".to_owned(), 1, 2, true));
        assert_eq!(summary(&games[2]), ("tally".to_owned(), 0, 1, false));
        assert!(
            games
                .iter()
                .all(|g| g["updatedAt"].as_i64().unwrap() > 1_700_000_000_000)
        );
    }

    #[sqlx::test]
    async fn listing_leaves_out_other_peoples_games(pool: PgPool) {
        let app = app(pool);
        let (_, ada) = app.register_user().await;
        let (_, grace) = app.register_user().await;
        app.create_game(&ada, "tally").await;

        assert_eq!(list(&app, &grace).await, json!([]));
    }

    #[sqlx::test]
    async fn listing_works_for_games_that_are_not_in_memory(pool: PgPool) {
        let before = app(pool.clone());
        let (_, token) = before.register_user().await;
        let game_id = before.create_game(&token, "tally").await;

        // A new app has no rooms, as after a restart.
        let after = app(pool);

        let games = list(&after, &token).await;
        assert_eq!(games[0]["gameId"], game_id.as_str());
    }

    #[sqlx::test]
    async fn listing_needs_a_known_token(pool: PgPool) {
        let app = app(pool);

        for authorization in [None, Some("Bearer unknown")] {
            let reply = app
                .send(Method::GET, "/api/games", authorization, None)
                .await;
            assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        }
    }
}
