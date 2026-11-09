//! Creating, joining, listing and replaying games over HTTP. Playing happens on the game's
//! WebSocket (see `socket`).
//!
//! A game's id is its invite: whoever has it can join while a seat is free, and can watch
//! the game on its WebSocket whether or not they have a seat. Ids are random (see
//! `game_id`), so they can't be found by guessing.
//!
//! The one way to find an id without being told it is the public list
//! (`GET /api/public-games`). A game is in it only if the player who made it said so, and only
//! once it has started: while a seat is free the id is still an invite to one person.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::{
    auth::AuthUser,
    bot::BOT_USER,
    error::ApiError,
    game_id::GameId,
    rematch::Rematch,
    room::{RoomError, Rooms},
};

/// The most games `GET /api/games` and `GET /api/public-games` return, newest activity first.
const LIST_LIMIT: i64 = 100;

#[derive(Deserialize)]
pub struct NewGame {
    kind: String,
    /// Play against the computer. The game starts at once, with the bot in seat 1.
    #[serde(default)]
    bot: bool,
    /// Put the game in the public list once it has started. Off unless asked for: the id of a
    /// game that is listed is no secret any more.
    #[serde(default)]
    public: bool,
}

/// Where a user sits in a game.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Seat {
    game_id: GameId,
    seat: usize,
}

/// `POST /api/games` with `{ "kind": "...", "bot": false, "public": false }`: creates a game,
/// with the user in seat 0, and loads it. With `"bot": true` the computer takes the other seat
/// and the game starts at once. With `"public": true` the game is in the public list once it
/// has started (see [`list_public_games`]). `bot` and `public` can be left out, which is false.
/// Answers 422 for a kind the server doesn't offer, and for a bot in a game that has none.
pub async fn create_game(
    AuthUser(user): AuthUser,
    State(rooms): State<Rooms>,
    Json(body): Json<NewGame>,
) -> Result<(StatusCode, Json<Seat>), ApiError> {
    let engine = rooms
        .games()
        .get(&body.kind)
        .ok_or(ApiError::Invalid("unknown kind of game"))?;
    let game_id = if body.bot {
        rooms.create_against_bot(engine, user, body.public).await
    } else {
        rooms.create(engine, user, body.public).await
    }
    .map_err(api_error)?;
    Ok((StatusCode::CREATED, Json(Seat { game_id, seat: 0 })))
}

/// `POST /api/games/{id}/join`: takes the next free seat, which starts the game if it
/// was the last. Joining a game the user is in is fine and returns their seat.
/// Answers 404 for an unknown game and 409 if it is full.
pub async fn join_game(
    AuthUser(user): AuthUser,
    State(rooms): State<Rooms>,
    Path(game_id): Path<GameId>,
) -> Result<Json<Seat>, ApiError> {
    let seat = rooms.join(&game_id, user).await.map_err(api_error)?;
    Ok(Json(Seat { game_id, seat }))
}

/// Where a game's rematch stands, as `POST` and `DELETE /api/games/{id}/rematch` answer.
/// The same value is in the game's snapshots, which is how the other player finds out.
#[derive(Serialize)]
pub struct RematchReply {
    rematch: Option<Rematch>,
}

/// `POST /api/games/{id}/rematch`: a player of a finished game asks to play it again. If the
/// other player has asked already, this is the answer yes. Either way, once both want it the
/// new game exists, with the same players in the same seats, and the reply names it:
/// `{ "rematch": { "type": "accepted", "gameId": "…" } }`. Against the computer that is
/// at once. Otherwise the reply is the offer, `{ "type": "offered", "by": <seat> }`, which the
/// other player sees in their snapshot. Asking again changes nothing.
///
/// Answers 403 to someone who isn't a player in the game, 404 for an unknown game, 409 while
/// the game is not over and 422 for a game that isn't for two players.
pub async fn ask_rematch(
    AuthUser(user): AuthUser,
    State(rooms): State<Rooms>,
    Path(game_id): Path<GameId>,
) -> Result<Json<RematchReply>, ApiError> {
    let rematch = rooms.ask_rematch(&game_id, user).await.map_err(api_error)?;
    Ok(Json(RematchReply { rematch }))
}

/// `DELETE /api/games/{id}/rematch`: a player takes back their own ask, which leaves no
/// rematch, or turns down the other player's, which leaves
/// `{ "type": "declined", "by": <seat of the one who asked> }`. With nothing to take back or
/// turn down it changes nothing. The same errors as asking.
pub async fn decline_rematch(
    AuthUser(user): AuthUser,
    State(rooms): State<Rooms>,
    Path(game_id): Path<GameId>,
) -> Result<Json<RematchReply>, ApiError> {
    let rematch = rooms
        .decline_rematch(&game_id, user)
        .await
        .map_err(api_error)?;
    Ok(Json(RematchReply { rematch }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Games {
    games: Vec<Listed>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    game_id: GameId,
    kind: String,
    /// The user's seat.
    seat: i16,
    /// How many seats are taken.
    joined: i64,
    /// False while the game waits for more players.
    started: bool,
    /// True once the game has ended (see `Game::is_over`).
    finished: bool,
    /// When the game last changed, in milliseconds since the epoch.
    updated_at: i64,
    /// The display names of the players who have joined, by seat: null for one who hasn't
    /// picked a name. As in a game's snapshot, so `player_names[seat]` is the user's own name
    /// in their seat.
    player_names: Vec<Option<String>>,
    /// Which of those players are guests, by seat, as in a game's snapshot
    /// (`Snapshot::player_guests`).
    player_guests: Vec<bool>,
}

/// One row of the list query, in the order of its columns.
type ListedRow = (
    GameId,
    String,
    i16,
    i64,
    bool,
    bool,
    i64,
    Vec<Option<String>>,
    Vec<bool>,
);

/// `GET /api/games`: the games the user is in, most recently changed first, at most 100.
/// Read from the database, so it also lists games that aren't in memory.
pub async fn list_games(
    AuthUser(user): AuthUser,
    State(pool): State<PgPool>,
) -> Result<Json<Games>, ApiError> {
    let rows: Vec<ListedRow> = sqlx::query_as(
        "SELECT g.id,
                g.kind,
                p.seat,
                (SELECT count(*) FROM game_players WHERE game_id = g.id),
                g.state IS NOT NULL,
                g.finished,
                (extract(epoch FROM g.updated_at) * 1000)::bigint,
                ARRAY(SELECT u.name
                      FROM game_players gp
                      JOIN users u ON u.id = gp.user_id
                      WHERE gp.game_id = g.id
                      ORDER BY gp.seat),
                -- A guest here is one in a room (`read_players` in `room`): keep the two the same.
                ARRAY(SELECT u.username IS NULL AND u.deleted_at IS NULL AND u.id <> $3
                      FROM game_players gp
                      JOIN users u ON u.id = gp.user_id
                      WHERE gp.game_id = g.id
                      ORDER BY gp.seat)
         FROM game_players p
         JOIN games g ON g.id = p.game_id
         WHERE p.user_id = $1
         ORDER BY g.updated_at DESC, g.id
         LIMIT $2",
    )
    .bind(user)
    .bind(LIST_LIMIT)
    .bind(BOT_USER)
    .fetch_all(&pool)
    .await
    .map_err(ApiError::database("could not list a user's games"))?;
    let games = rows
        .into_iter()
        .map(
            |(
                game_id,
                kind,
                seat,
                joined,
                started,
                finished,
                updated_at,
                player_names,
                player_guests,
            )| Listed {
                game_id,
                kind,
                seat,
                joined,
                started,
                finished,
                updated_at,
                player_names,
                player_guests,
            },
        )
        .collect();
    Ok(Json(Games { games }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicGames {
    games: Vec<PublicListed>,
}

/// A game in the public list. Unlike [`Listed`] it has no seat of the reader's, because the
/// reader needn't be a player, or even a user.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicListed {
    game_id: GameId,
    kind: String,
    /// True once the game has ended (see `Game::is_over`). A game that hasn't is in progress:
    /// every listed game has started.
    finished: bool,
    /// When the game last changed, in milliseconds since the epoch.
    updated_at: i64,
    /// As in [`Listed`]: the players' display names by seat, null for one with no name.
    player_names: Vec<Option<String>>,
    /// As in [`Listed`]: which of the players are guests, by seat.
    player_guests: Vec<bool>,
}

/// One row of the public list query, in the order of its columns.
type PublicListedRow = (GameId, String, bool, i64, Vec<Option<String>>, Vec<bool>);

/// `GET /api/public-games`: the games that were made public and have started, most recently
/// changed first, at most 100. **Needs no token**: the list is for anyone, and a game's id in
/// it is all that is needed to watch the game, as on its WebSocket. A game that waits for an
/// opponent isn't listed, so that the list never offers a seat.
pub async fn list_public_games(State(pool): State<PgPool>) -> Result<Json<PublicGames>, ApiError> {
    let rows: Vec<PublicListedRow> = sqlx::query_as(
        "SELECT g.id,
                g.kind,
                g.finished,
                (extract(epoch FROM g.updated_at) * 1000)::bigint,
                ARRAY(SELECT u.name
                      FROM game_players gp
                      JOIN users u ON u.id = gp.user_id
                      WHERE gp.game_id = g.id
                      ORDER BY gp.seat),
                -- A guest here is one in a room (`read_players` in `room`): keep the two the same.
                ARRAY(SELECT u.username IS NULL AND u.deleted_at IS NULL AND u.id <> $2
                      FROM game_players gp
                      JOIN users u ON u.id = gp.user_id
                      WHERE gp.game_id = g.id
                      ORDER BY gp.seat)
         FROM games g
         WHERE g.public AND g.state IS NOT NULL
         ORDER BY g.updated_at DESC, g.id
         LIMIT $1",
    )
    .bind(LIST_LIMIT)
    .bind(BOT_USER)
    .fetch_all(&pool)
    .await
    .map_err(ApiError::database("could not list the public games"))?;
    let games = rows
        .into_iter()
        .map(
            |(game_id, kind, finished, updated_at, player_names, player_guests)| PublicListed {
                game_id,
                kind,
                finished,
                updated_at,
                player_names,
                player_guests,
            },
        )
        .collect();
    Ok(Json(PublicGames { games }))
}

fn api_error(err: RoomError) -> ApiError {
    match err {
        RoomError::NotFound => ApiError::NotFound,
        RoomError::Full => ApiError::Conflict("the game is full"),
        RoomError::NoBot => ApiError::Invalid("this game has no computer opponent"),
        RoomError::NotAPlayer => ApiError::Forbidden("you are not a player in this game"),
        RoomError::NotOver => ApiError::Conflict("the game is not over yet"),
        RoomError::NoRematch => ApiError::Invalid("this game has no rematch"),
        // Creating, joining and the rematch don't produce the others. If one shows up, it is our bug.
        RoomError::NotStarted | RoomError::Rejected(_) | RoomError::Internal | RoomError::Gone => {
            ApiError::Internal
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::Method;
    use serde_json::{Value, json};
    use uuid::Uuid;

    use super::*;
    use crate::{
        bot::BOT_USER,
        game,
        test_util::{Client, Quick, Solo, Tally, TestApp, bearer},
    };

    fn app(pool: PgPool) -> TestApp {
        TestApp::new(
            pool,
            game::Games::default()
                .with::<Tally>()
                .with::<Solo>()
                .with::<Quick>(),
        )
    }

    /// What the database holds for a game: revision, state version, state, players by seat.
    async fn stored(pool: &PgPool, game_id: &str) -> (i64, i32, Option<Value>, Vec<String>) {
        let id: GameId = game_id.parse().unwrap();
        let (revision, version, state): (i64, i32, Option<Value>) =
            sqlx::query_as("SELECT revision, state_version, state FROM games WHERE id = $1")
                .bind(&id)
                .fetch_one(pool)
                .await
                .unwrap();
        let players: Vec<Uuid> =
            sqlx::query_scalar("SELECT user_id FROM game_players WHERE game_id = $1 ORDER BY seat")
                .bind(&id)
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
    async fn the_server_offers_long_backgammon_under_the_id_of_the_front_end_catalog(pool: PgPool) {
        let app = TestApp::new(pool.clone(), game::registry());
        let (_, creator) = app.register_user().await;
        let (_, joiner) = app.register_user().await;

        let game_id = app.create_game(&creator, "long-backgammon").await;
        let (_, _, waiting, _) = stored(&pool, &game_id).await;
        assert_eq!(waiting, None);
        app.join_game(&joiner, &game_id).await;

        // The second player's arrival starts the game: White to roll, all on their heads.
        let (revision, _, state, players) = stored(&pool, &game_id).await;
        let state = state.expect("the game has started");
        assert_eq!((revision, players.len()), (1, 2));
        assert_eq!(state["phase"], json!({ "type": "roll" }));
        assert_eq!(state["turn"], state["white"]);
        assert_eq!(state["points"][0][0], 15);
        assert_eq!(state["points"][1][0], 15);
    }

    #[sqlx::test]
    async fn game_ids_are_short_and_random(pool: PgPool) {
        let app = app(pool);
        let (_, token) = app.register_user().await;

        let first = app.create_game(&token, "tally").await;
        let second = app.create_game(&token, "tally").await;

        assert_ne!(first, second);
        for id in [first, second] {
            assert_eq!(id.len(), crate::game_id::LENGTH, "{id}");
            assert!(id.parse::<GameId>().is_ok(), "{id} is not an id");
        }
    }

    #[sqlx::test]
    async fn a_game_from_before_ids_were_short_still_works_under_its_uuid(pool: PgPool) {
        let app = app(pool.clone());
        let (user_id, token) = app.register_user().await;
        let (_, joiner) = app.register_user().await;
        let old = "6f1c2a3e-5b4d-4c8a-9e0f-1a2b3c4d5e6f";
        sqlx::query("INSERT INTO games (id, kind, state_version) VALUES ($1, 'tally', 1)")
            .bind(old)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO game_players (game_id, seat, user_id) VALUES ($1, 0, $2)")
            .bind(old)
            .bind(user_id.parse::<Uuid>().unwrap())
            .execute(&pool)
            .await
            .unwrap();

        let listed = list(&app, &token).await;
        let joined = app.join_game(&joiner, old).await;

        assert_eq!(listed[0]["gameId"], old);
        assert_eq!(joined.status, StatusCode::OK);
        assert_eq!(joined.json, json!({ "gameId": old, "seat": 1 }));
    }

    #[sqlx::test]
    async fn a_game_against_the_bot_starts_at_once_with_the_bot_in_the_other_seat(pool: PgPool) {
        let app = app(pool.clone());
        let (user_id, token) = app.register_user().await;

        let reply = app.create_bot_game(&token, "tally").await;

        assert_eq!(reply.status, StatusCode::CREATED);
        assert_eq!(reply.json["seat"], 0);
        let game_id = reply.json["gameId"].as_str().unwrap();
        let bot = BOT_USER.to_string();
        assert_eq!(
            stored(&pool, game_id).await,
            (
                0,
                1,
                Some(json!({ "total": 0, "turn": 0 })),
                vec![user_id, bot]
            )
        );
        // The list says so too: two players, started, and the bot by its name.
        let listed = list(&app, &token).await;
        assert_eq!(listed[0]["joined"], 2);
        assert_eq!(listed[0]["started"], true);
        assert_eq!(listed[0]["playerNames"], json!([null, "Bot"]));
        // The user is a guest, and the bot is not.
        assert_eq!(listed[0]["playerGuests"], json!([true, false]));
    }

    #[sqlx::test]
    async fn nobody_can_take_the_bots_seat(pool: PgPool) {
        let app = app(pool);
        let (_, token) = app.register_user().await;
        let (_, other) = app.register_user().await;
        let game_id = app.create_bot_game(&token, "tally").await.json["gameId"]
            .as_str()
            .unwrap()
            .to_owned();

        let reply = app.join_game(&other, &game_id).await;

        assert_eq!(reply.status, StatusCode::CONFLICT);
    }

    #[sqlx::test]
    async fn the_bot_cannot_be_signed_in_as(pool: PgPool) {
        let app = app(pool);

        // The bot has no token, so no token reaches it, not even an empty one.
        for token in ["", "null", "bot", "Bot"] {
            let reply = app
                .send(Method::GET, "/api/me", Some(&bearer(token)), None)
                .await;
            assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{token:?}");
        }
    }

    #[sqlx::test]
    async fn a_bot_is_refused_in_a_game_that_has_none(pool: PgPool) {
        let app = app(pool.clone());
        let (_, token) = app.register_user().await;

        let reply = app.create_bot_game(&token, "solo").await;

        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        let games: i64 = sqlx::query_scalar("SELECT count(*) FROM games")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(games, 0, "a refused game must not be left behind");
    }

    #[sqlx::test]
    async fn without_a_bot_the_game_waits_for_a_player_as_before(pool: PgPool) {
        let app = app(pool.clone());
        let (user_id, token) = app.register_user().await;

        let reply = app
            .send(
                Method::POST,
                "/api/games",
                Some(&bearer(&token)),
                Some(json!({ "kind": "tally", "bot": false })),
            )
            .await;

        assert_eq!(reply.status, StatusCode::CREATED);
        let game_id = reply.json["gameId"].as_str().unwrap();
        assert_eq!(stored(&pool, game_id).await, (0, 1, None, vec![user_id]));
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

        let unknown_game = app.join_game(&other_token, "nosuchgame22").await;
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

    /// Gives a user a display name, the way a player does.
    async fn name(app: &TestApp, token: &str, name: &str) {
        let reply = app
            .send(
                Method::PATCH,
                "/api/me",
                Some(&bearer(token)),
                Some(json!({ "name": name })),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK);
    }

    #[sqlx::test]
    async fn listing_shows_the_names_of_the_players_by_seat(pool: PgPool) {
        let app = app(pool);
        let (_, ada) = app.register_user().await;
        let (_, grace) = app.register_user().await;
        name(&app, &ada, "Ada").await;
        let waiting = app.create_game(&ada, "tally").await;
        let started = app.create_game(&grace, "tally").await;
        app.join_game(&ada, &started).await;

        let games = list(&app, &ada).await;

        let names = |id: &str| {
            let game = games
                .as_array()
                .unwrap()
                .iter()
                .find(|g| g["gameId"] == id)
                .unwrap();
            game["playerNames"].clone()
        };
        // Grace has no name yet, and sits in seat 0 of the game she created.
        assert_eq!(names(&started), json!([null, "Ada"]));
        // Only the players who have joined are listed.
        assert_eq!(names(&waiting), json!(["Ada"]));
    }

    #[sqlx::test]
    async fn listing_shows_a_name_changed_since_the_game_began(pool: PgPool) {
        let app = app(pool);
        let (_, ada) = app.register_user().await;
        let game = app.create_game(&ada, "tally").await;
        name(&app, &ada, "Ada").await;
        name(&app, &ada, "Ada Lovelace").await;

        let games = list(&app, &ada).await;

        assert_eq!(games[0]["gameId"], game.as_str());
        assert_eq!(games[0]["playerNames"], json!(["Ada Lovelace"]));
    }

    #[sqlx::test]
    async fn listing_says_whether_a_game_has_finished(pool: PgPool) {
        let app = app(pool.clone());
        let (_, ada) = app.register_user().await;
        let waiting = app.create_game(&ada, "tally").await;
        let playing = app.create_game(&ada, "solo").await;
        let done = app.create_game(&ada, "solo").await;
        // What the room writes when a game's rules say it is over (see the room's tests).
        sqlx::query("UPDATE games SET finished = true WHERE id = $1")
            .bind(&done)
            .execute(&pool)
            .await
            .unwrap();

        let games = list(&app, &ada).await;

        let state = |id: &str| {
            let game = games
                .as_array()
                .unwrap()
                .iter()
                .find(|g| g["gameId"] == id)
                .unwrap();
            (
                game["started"].as_bool().unwrap(),
                game["finished"].as_bool().unwrap(),
            )
        };
        assert_eq!(state(&waiting), (false, false));
        assert_eq!(state(&playing), (true, false));
        assert_eq!(state(&done), (true, true));
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

    // --- The public list ---

    /// Creates a game as the token's user, with the options given as the request body does.
    /// Returns its id.
    async fn create_with(app: &TestApp, token: &str, body: Value) -> String {
        let reply = app
            .send(Method::POST, "/api/games", Some(&bearer(token)), Some(body))
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.json);
        reply.json["gameId"].as_str().unwrap().to_owned()
    }

    /// The public list, asked for by someone who has no token.
    async fn public_list(app: &TestApp) -> Value {
        let reply = app.send(Method::GET, "/api/public-games", None, None).await;
        assert_eq!(reply.status, StatusCode::OK);
        reply.json["games"].clone()
    }

    fn ids(games: &Value) -> Vec<&str> {
        games
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["gameId"].as_str().unwrap())
            .collect()
    }

    #[sqlx::test]
    async fn a_public_game_is_listed_once_it_has_started_and_not_before(pool: PgPool) {
        let app = app(pool);
        let (_, ada) = app.register_user().await;
        let (_, grace) = app.register_user().await;
        name(&app, &ada, "Ada").await;
        let game_id = create_with(&app, &ada, json!({ "kind": "tally", "public": true })).await;

        // One seat is free, so the id is still an invite and stays unlisted.
        assert_eq!(public_list(&app).await, json!([]));

        app.join_game(&grace, &game_id).await;

        let games = public_list(&app).await;
        assert_eq!(ids(&games), [game_id.as_str()]);
        let game = &games[0];
        assert_eq!(game["kind"], "tally");
        assert_eq!(game["finished"], false);
        // Grace has no name. Ada is a guest, so her name is marked as one.
        assert_eq!(game["playerNames"], json!(["Ada", null]));
        assert_eq!(game["playerGuests"], json!([true, true]));
        assert!(game["updatedAt"].as_i64().unwrap() > 1_700_000_000_000);
        // Only what a list needs: nothing about the reader, and no seat to take.
        assert!(game.get("seat").is_none());
    }

    #[sqlx::test]
    async fn a_game_is_private_unless_it_was_made_public(pool: PgPool) {
        let app = app(pool);
        let (_, ada) = app.register_user().await;
        let (_, grace) = app.register_user().await;
        // Left out, and said no.
        for body in [
            json!({ "kind": "tally" }),
            json!({ "kind": "tally", "public": false }),
            json!({ "kind": "solo" }),
            json!({ "kind": "quick", "bot": true, "public": false }),
        ] {
            let game_id = create_with(&app, &ada, body).await;
            app.join_game(&grace, &game_id).await;
        }

        assert_eq!(public_list(&app).await, json!([]));
    }

    #[sqlx::test]
    async fn a_public_game_against_the_bot_is_listed_at_once(pool: PgPool) {
        let app = app(pool);
        let (_, ada) = app.register_user().await;
        name(&app, &ada, "Ada").await;
        let game_id = create_with(
            &app,
            &ada,
            json!({ "kind": "quick", "bot": true, "public": true }),
        )
        .await;

        let games = public_list(&app).await;

        assert_eq!(ids(&games), [game_id.as_str()]);
        // The bot is a player with a name of its own, and is not a guest.
        assert_eq!(games[0]["playerNames"], json!(["Ada", "Bot"]));
        assert_eq!(games[0]["playerGuests"], json!([true, false]));
    }

    #[sqlx::test]
    async fn a_public_game_for_one_player_is_listed_at_once(pool: PgPool) {
        let app = app(pool);
        let (_, ada) = app.register_user().await;
        let game_id = create_with(&app, &ada, json!({ "kind": "solo", "public": true })).await;

        assert_eq!(ids(&public_list(&app).await), [game_id.as_str()]);
    }

    #[sqlx::test]
    async fn the_public_list_shows_newest_change_first_and_says_which_games_are_over(pool: PgPool) {
        let app = app(pool.clone());
        let (_, ada) = app.register_user().await;
        let first = create_with(&app, &ada, json!({ "kind": "solo", "public": true })).await;
        let second = create_with(&app, &ada, json!({ "kind": "solo", "public": true })).await;
        let third = create_with(&app, &ada, json!({ "kind": "solo", "public": true })).await;
        // What the room writes when a game's rules say it is over (see the room's tests). It
        // also moves `updated_at`, which a save does too.
        sqlx::query("UPDATE games SET finished = true, updated_at = now() WHERE id = $1")
            .bind(&first)
            .execute(&pool)
            .await
            .unwrap();

        let games = public_list(&app).await;

        assert_eq!(
            ids(&games),
            [first.as_str(), third.as_str(), second.as_str()]
        );
        let finished: Vec<_> = games
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["finished"].as_bool().unwrap())
            .collect();
        assert_eq!(finished, [true, false, false]);
    }

    #[sqlx::test]
    async fn the_public_list_stops_at_a_hundred_games(pool: PgPool) {
        // Made by hand: a hundred and one rooms are more than a test needs to keep alive.
        sqlx::query(
            "INSERT INTO games (id, kind, state_version, state, public)
             SELECT 'game' || lpad(n::text, 8, '0'), 'solo', 1, '{\"count\": 0}', true
             FROM generate_series(1, 101) AS n",
        )
        .execute(&pool)
        .await
        .unwrap();
        let app = app(pool);

        assert_eq!(public_list(&app).await.as_array().unwrap().len(), 100);
    }

    #[sqlx::test]
    async fn games_that_existed_before_the_list_are_not_public(pool: PgPool) {
        let app = app(pool.clone());
        let (_, ada) = app.register_user().await;
        let game_id = app.create_game(&ada, "solo").await;
        // The column's default is what an old row got when the migration added it.
        let public: bool = sqlx::query_scalar("SELECT public FROM games WHERE id = $1")
            .bind(&game_id)
            .fetch_one(&pool)
            .await
            .unwrap();

        assert!(!public);
        assert_eq!(public_list(&app).await, json!([]));
    }

    #[sqlx::test]
    async fn the_public_list_needs_no_token(pool: PgPool) {
        let app = app(pool);
        let (_, ada) = app.register_user().await;
        let game_id = create_with(&app, &ada, json!({ "kind": "solo", "public": true })).await;

        // Whatever the request carries: the list is the same, and so for a token that is wrong.
        for authorization in [None, Some("Bearer unknown")] {
            let reply = app
                .send(Method::GET, "/api/public-games", authorization, None)
                .await;
            assert_eq!(reply.status, StatusCode::OK);
            assert_eq!(ids(&reply.json["games"]), [game_id.as_str()]);
        }
    }

    #[sqlx::test]
    async fn listing_a_game_does_not_open_its_history_to_people_without_a_token(pool: PgPool) {
        // The list is a way to find ids, not a new way to read a game: its history is still
        // for users, as it was.
        let app = app(pool);
        let (_, ada) = app.register_user().await;
        let game_id = create_with(&app, &ada, json!({ "kind": "solo", "public": true })).await;

        assert_eq!(
            app.history(None, &game_id).await.status,
            StatusCode::UNAUTHORIZED
        );
    }

    #[sqlx::test]
    async fn a_rematch_is_as_public_as_the_game_it_follows(pool: PgPool) {
        let app = app(pool.clone());
        let (_, ada) = app.register_user().await;
        let server = app.serve().await;
        let mut rematches = Vec::new();
        for public in [true, false] {
            let game_id = create_with(
                &app,
                &ada,
                json!({ "kind": "quick", "bot": true, "public": public }),
            )
            .await;
            let mut client = Client::sign_in(&server, &game_id, &ada).await;
            client.next().await;
            client.act(json!({})).await;
            client.next().await;
            let reply = app.ask_rematch(&ada, &game_id).await;
            assert_eq!(reply.status, StatusCode::OK);
            rematches.push(reply.json["rematch"]["gameId"].as_str().unwrap().to_owned());
        }

        let listed = public_list(&app).await;

        // Both the first game and its rematch are public; the private pair is nowhere.
        assert_eq!(listed.as_array().unwrap().len(), 2);
        assert!(ids(&listed).contains(&rematches[0].as_str()));
        assert!(!ids(&listed).contains(&rematches[1].as_str()));
    }

    // --- The rematch ---

    #[sqlx::test]
    async fn asking_offers_a_rematch_and_the_other_players_yes_makes_the_new_game(pool: PgPool) {
        let app = app(pool.clone());
        let (game_id, [(ada_id, ada), (grace_id, grace)]) = app.finished_quick_game().await;

        let offer = app.ask_rematch(&ada, &game_id).await;
        let answer = app.ask_rematch(&grace, &game_id).await;

        assert_eq!(offer.status, StatusCode::OK);
        assert_eq!(
            offer.json,
            json!({ "rematch": { "type": "offered", "by": 0 } })
        );
        assert_eq!(answer.status, StatusCode::OK);
        assert_eq!(answer.json["rematch"]["type"], "accepted");
        // The new game is a fresh one with both players in the seats they had...
        let next = answer.json["rematch"]["gameId"].as_str().unwrap();
        assert_ne!(next, game_id);
        assert_eq!(
            stored(&pool, next).await,
            (0, 1, Some(json!({ "over": false })), vec![ada_id, grace_id])
        );
        // ...and in both their lists, under the one they just played.
        for token in [&ada, &grace] {
            let games = list(&app, token).await;
            let games = games.as_array().unwrap();
            let listed = |id: &str| games.iter().find(|g| g["gameId"] == id).cloned();
            assert_eq!(listed(next).unwrap()["started"], true);
            assert_eq!(listed(next).unwrap()["finished"], false);
            assert_eq!(listed(&game_id).unwrap()["finished"], true);
        }
    }

    #[sqlx::test]
    async fn turning_down_or_taking_back_a_rematch_says_what_is_left(pool: PgPool) {
        let app = app(pool.clone());
        let (game_id, [(_, ada), (_, grace)]) = app.finished_quick_game().await;
        app.ask_rematch(&ada, &game_id).await;

        let turned_down = app.decline_rematch(&grace, &game_id).await;
        app.ask_rematch(&ada, &game_id).await;
        let taken_back = app.decline_rematch(&ada, &game_id).await;

        assert_eq!(turned_down.status, StatusCode::OK);
        assert_eq!(
            turned_down.json,
            json!({ "rematch": { "type": "declined", "by": 0 } })
        );
        assert_eq!(taken_back.status, StatusCode::OK);
        assert_eq!(taken_back.json, json!({ "rematch": null }));
    }

    #[sqlx::test]
    async fn the_bot_always_agrees_to_a_rematch(pool: PgPool) {
        let app = app(pool.clone());
        let (user_id, token) = app.register_user().await;
        let game_id = app.create_bot_game(&token, "quick").await.json["gameId"]
            .as_str()
            .unwrap()
            .to_owned();
        let server = app.serve().await;
        let mut client = Client::sign_in(&server, &game_id, &token).await;
        client.next().await;
        client.act(json!({})).await;
        client.next().await;

        let reply = app.ask_rematch(&token, &game_id).await;

        assert_eq!(reply.status, StatusCode::OK);
        let next = reply.json["rematch"]["gameId"].as_str().unwrap();
        let (_, _, state, players) = stored(&pool, next).await;
        assert_eq!(state, Some(json!({ "over": false })));
        assert_eq!(players, vec![user_id, BOT_USER.to_string()]);
    }

    #[sqlx::test]
    async fn a_game_that_is_still_on_cannot_be_replayed(pool: PgPool) {
        let app = app(pool.clone());
        let (_, ada) = app.register_user().await;
        let (_, grace) = app.register_user().await;
        let game_id = app.create_game(&ada, "quick").await;
        app.join_game(&grace, &game_id).await;

        for reply in [
            app.ask_rematch(&ada, &game_id).await,
            app.decline_rematch(&ada, &game_id).await,
        ] {
            assert_eq!(reply.status, StatusCode::CONFLICT);
        }
        let games: i64 = sqlx::query_scalar("SELECT count(*) FROM games")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(games, 1);
    }

    #[sqlx::test]
    async fn only_a_player_of_the_game_can_ask_for_a_rematch(pool: PgPool) {
        let app = app(pool);
        let (game_id, _) = app.finished_quick_game().await;
        let (_, outsider) = app.register_user().await;

        for reply in [
            app.ask_rematch(&outsider, &game_id).await,
            app.decline_rematch(&outsider, &game_id).await,
        ] {
            assert_eq!(reply.status, StatusCode::FORBIDDEN);
        }
    }

    #[sqlx::test]
    async fn a_rematch_needs_a_known_token_and_a_known_game(pool: PgPool) {
        let app = app(pool);
        let (game_id, [(_, ada), _]) = app.finished_quick_game().await;

        for method in [Method::POST, Method::DELETE] {
            for authorization in [None, Some("Bearer unknown")] {
                let reply = app
                    .send(
                        method.clone(),
                        &format!("/api/games/{game_id}/rematch"),
                        authorization,
                        None,
                    )
                    .await;
                assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
            }
        }
        let unknown = app.ask_rematch(&ada, "nosuchgame22").await;
        assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    }
}
