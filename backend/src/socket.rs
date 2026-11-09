//! The WebSocket that keeps a client in sync with a game: `GET /api/games/{id}/ws`.
//!
//! Every message is a JSON text frame with a `type`.
//!
//! The client speaks first. A browser can't set an `Authorization` header on a
//! WebSocket, and a token in the URL ends up in logs, so the first message carries it:
//!
//! ```json
//! { "type": "hello", "token": "<access token>" }
//! ```
//!
//! If that works, the server answers with a snapshot and sends a new one after every
//! change to the game, including a player joining. A snapshot is the whole game, so
//! the client replaces what it has. Snapshots arrive in order, but a slow client may
//! miss some in between; `revision` says which is newer.
//!
//! ```json
//! { "type": "snapshot", "gameId": "…", "kind": "…", "revision": 3, "stateVersion": 1,
//!   "players": ["<user id of seat 0>", "…"], "playerNames": ["Ada", null], "state": { … },
//!   "rematch": null }
//! ```
//!
//! `state` is whatever the game defines, and is null until every seat is taken. A snapshot
//! holds only the newest state; the ones before it are in the game's history, which is read
//! over HTTP (see `history`) and whose `revision`s are the ones snapshots carry.
//! `playerNames` is parallel to `players` and null for a player who has no name. A player
//! who changes their name is published at once, as a snapshot with the same `revision` as
//! before (the game did not change), so replace what you have unless `revision` is lower.
//!
//! `rematch` is null until a player of the finished game asks to play it again (over HTTP,
//! see `lobby`). Then it is `{ "type": "offered", "by": <seat> }` until the other player
//! answers, and after that `{ "type": "declined", "by": <seat> }`, or
//! `{ "type": "accepted", "gameId": "…" }` for the new game, which has the same players.
//! Each step is a new `revision`.
//!
//! **Anyone with a token who knows the game's id may connect and watch.** The client's own
//! seat is its index in `players`; a client that isn't in `players` is a spectator and
//! gets the same snapshots. A spectator who then joins the game over HTTP is a player on
//! the connection they already have: the next snapshot lists them in `players`.
//!
//! To play, the client sends an action, whose shape the game defines:
//!
//! ```json
//! { "type": "action", "action": { … } }
//! ```
//!
//! An accepted action comes back to everyone, the sender too, as a snapshot. A refused
//! one gets an error, to the sender only, and changes nothing:
//!
//! ```json
//! { "type": "error", "code": "rejected", "message": "not your turn" }
//! ```
//!
//! The codes are `rejected` (against the rules), `not-started`, `not-a-player` (the
//! sender has no seat in the game), `bad-message` and `internal`. The connection stays
//! open after an error.
//!
//! The server closes the socket, with a code from [`close`], if the client can't
//! be admitted or the game goes away. After 1012 the client can reconnect for a fresh start.

use std::time::Duration;

use axum::{
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use tokio::time::timeout;

use crate::{
    auth::authenticate,
    error::ApiError,
    game_id::GameId,
    room::{Connection, RoomError, Rooms, Snapshot},
};

/// How long a new socket may take to say hello before it is dropped.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// Larger than any action should be. The WebSocket library drops bigger messages.
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// Close codes. The 4000s are ours.
pub mod close {
    /// The first message wasn't a hello, or didn't come in time.
    pub const BAD_REQUEST: u16 = 4400;
    /// The token isn't known.
    pub const UNAUTHORIZED: u16 = 4401;
    /// There is no such game.
    pub const NOT_FOUND: u16 = 4404;
    /// The server failed.
    pub const INTERNAL: u16 = 1011;
    /// The game left memory, e.g. because it couldn't be saved. Connect again.
    pub const RESTART: u16 = 1012;
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    Hello { token: String },
    Action { action: Value },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerMessage<'a> {
    Snapshot(&'a Snapshot),
    Error { code: &'static str, message: String },
}

/// `GET /api/games/{id}/ws`. Whether the game exists and the user may enter is only
/// known after the hello, so the upgrade itself always succeeds.
pub async fn connect(
    upgrade: WebSocketUpgrade,
    Path(game_id): Path<GameId>,
    State(pool): State<PgPool>,
    State(rooms): State<Rooms>,
) -> Response {
    upgrade
        .max_message_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| serve(socket, pool, rooms, game_id))
}

/// The peer is gone or the socket is unusable.
struct Disconnected;

async fn serve(mut socket: WebSocket, pool: PgPool, rooms: Rooms, game_id: GameId) {
    let mut connection = match sign_in(&mut socket, &pool, &rooms, &game_id).await {
        Ok(connection) => connection,
        Err(code) => return hang_up(socket, code).await,
    };
    let result = relay(&mut socket, &mut connection).await;
    // A closed room is the only reason to hang up from our side; otherwise the peer left.
    if let Err(code) = result {
        hang_up(socket, code).await;
    }
}

/// Reads the hello, checks the token, and connects to the room. On failure
/// returns the close code to give the client.
async fn sign_in(
    socket: &mut WebSocket,
    pool: &PgPool,
    rooms: &Rooms,
    game_id: &GameId,
) -> Result<Connection, u16> {
    let hello = timeout(HELLO_TIMEOUT, async {
        loop {
            match socket.recv().await {
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                other => return other,
            }
        }
    })
    .await;
    let Ok(Some(Ok(Message::Text(text)))) = hello else {
        return Err(close::BAD_REQUEST);
    };
    let Ok(ClientMessage::Hello { token }) = serde_json::from_str(&text) else {
        return Err(close::BAD_REQUEST);
    };

    // The token is checked before the game, so that nobody can probe for game ids.
    let user = authenticate(pool, &token).await.map_err(|err| match err {
        ApiError::Unauthorized => close::UNAUTHORIZED,
        _ => close::INTERNAL,
    })?;
    rooms.connect(game_id, user).await.map_err(|err| match err {
        RoomError::NotFound => close::NOT_FOUND,
        _ => close::INTERNAL,
    })
}

/// Sends snapshots and handles actions until the client leaves (`Ok`) or the room
/// goes away (`Err` with the close code to give).
async fn relay(socket: &mut WebSocket, connection: &mut Connection) -> Result<(), u16> {
    let first = connection.latest();
    if send(socket, &ServerMessage::Snapshot(&first))
        .await
        .is_err()
    {
        return Ok(());
    }
    loop {
        tokio::select! {
            snapshot = connection.changed() => {
                let Some(snapshot) = snapshot else { return Err(close::RESTART) };
                if send(socket, &ServerMessage::Snapshot(&snapshot)).await.is_err() {
                    return Ok(());
                }
            }
            message = socket.recv() => match message {
                Some(Ok(Message::Text(text))) => {
                    match on_text(socket, connection, &text).await {
                        Ok(()) => {}
                        Err(Failure::Disconnected) => return Ok(()),
                        Err(Failure::RoomGone) => return Err(close::RESTART),
                    }
                }
                Some(Ok(Message::Binary(_))) => {
                    let sent = send_error(socket, "bad-message", "messages must be text").await;
                    if sent.is_err() { return Ok(()) }
                }
                // Pings are answered by the library. A close or a broken socket ends it.
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Ok(()),
            },
        }
    }
}

enum Failure {
    Disconnected,
    RoomGone,
}

async fn on_text(
    socket: &mut WebSocket,
    connection: &Connection,
    text: &str,
) -> Result<(), Failure> {
    let action = match serde_json::from_str::<ClientMessage>(text) {
        Ok(ClientMessage::Action { action }) => action,
        Ok(ClientMessage::Hello { .. }) => {
            return report(socket, "bad-message", "already signed in").await;
        }
        Err(err) => return report(socket, "bad-message", &err.to_string()).await,
    };
    match connection.act(action).await {
        // The new state reaches this client like everyone else's, as a snapshot.
        Ok(()) => Ok(()),
        Err(RoomError::Rejected(reason)) => report(socket, "rejected", &reason).await,
        Err(RoomError::NotStarted) => {
            report(
                socket,
                "not-started",
                "the game is waiting for more players",
            )
            .await
        }
        Err(RoomError::NotAPlayer) => {
            report(
                socket,
                "not-a-player",
                "you are watching this game, not playing it",
            )
            .await
        }
        Err(RoomError::Gone) => Err(Failure::RoomGone),
        Err(_) => report(socket, "internal", "something went wrong on the server").await,
    }
}

async fn report(socket: &mut WebSocket, code: &'static str, message: &str) -> Result<(), Failure> {
    send_error(socket, code, message)
        .await
        .map_err(|Disconnected| Failure::Disconnected)
}

async fn send_error(
    socket: &mut WebSocket,
    code: &'static str,
    message: &str,
) -> Result<(), Disconnected> {
    let message = ServerMessage::Error {
        code,
        message: message.to_owned(),
    };
    send(socket, &message).await
}

async fn send(socket: &mut WebSocket, message: &ServerMessage<'_>) -> Result<(), Disconnected> {
    let text = serde_json::to_string(message).map_err(|err| {
        tracing::error!(%err, "could not serialize a message");
        Disconnected
    })?;
    socket
        .send(Message::text(text))
        .await
        .map_err(|_| Disconnected)
}

/// Tells the client why we are leaving. Failing is fine: the client may be gone already.
async fn hang_up(mut socket: WebSocket, code: u16) {
    let frame = CloseFrame {
        code,
        reason: "".into(),
    };
    let _ = socket.send(Message::Close(Some(frame))).await;
}

#[cfg(test)]
mod tests {
    use axum::http::Method;
    use serde_json::json;

    use super::*;
    use crate::{
        game::Games,
        test_util::{Client, Quick, Tally, TestApp, bearer},
    };

    /// Changes the name of the token's user.
    async fn rename(app: &TestApp, token: &str, name: &str) {
        let reply = app
            .send(
                Method::PATCH,
                "/api/me",
                Some(&bearer(token)),
                Some(json!({ "name": name })),
            )
            .await;
        assert_eq!(reply.status, axum::http::StatusCode::OK);
    }

    fn app(pool: PgPool) -> TestApp {
        TestApp::new(pool, Games::default().with::<Tally>())
    }

    /// A started tally game with two users: (game id, [(user id, token); 2]).
    async fn started_game(app: &TestApp) -> (String, [(String, String); 2]) {
        let first = app.register_user().await;
        let second = app.register_user().await;
        let game_id = app.create_game(&first.1, "tally").await;
        app.join_game(&second.1, &game_id).await;
        (game_id, [first, second])
    }

    fn add(amount: i64) -> Value {
        json!({ "type": "add", "amount": amount })
    }

    #[sqlx::test]
    async fn an_unknown_token_is_closed_as_unauthorized(pool: PgPool) {
        let app = app(pool);
        let (game_id, _) = started_game(&app).await;
        let server = app.serve().await;

        let mut client = Client::sign_in(&server, &game_id, "unknown").await;

        assert_eq!(client.closed().await, close::UNAUTHORIZED);
    }

    #[sqlx::test]
    async fn the_token_is_checked_before_the_game_is_looked_up(pool: PgPool) {
        let app = app(pool);
        let server = app.serve().await;
        let nowhere = "nosuchgame22".to_owned();

        let mut client = Client::sign_in(&server, &nowhere, "unknown").await;

        assert_eq!(client.closed().await, close::UNAUTHORIZED);
    }

    #[sqlx::test]
    async fn a_first_message_that_is_not_a_hello_is_closed_as_a_bad_request(pool: PgPool) {
        let app = app(pool);
        let (game_id, _) = started_game(&app).await;
        let server = app.serve().await;

        for first in [
            json!({ "type": "action", "action": add(1) }),
            json!("hello"),
        ] {
            let mut client = Client::connect(&server, &game_id).await;
            client.say(first).await;
            assert_eq!(client.closed().await, close::BAD_REQUEST);
        }
    }

    #[sqlx::test]
    async fn a_user_without_a_seat_watches_the_game(pool: PgPool) {
        let app = app(pool);
        let (game_id, [(_, first), _]) = started_game(&app).await;
        let (watcher_id, watcher_token) = app.register_user().await;
        let server = app.serve().await;
        let mut ada = Client::sign_in(&server, &game_id, &first).await;
        let mut watcher = Client::sign_in(&server, &game_id, &watcher_token).await;

        let seen = watcher.next().await;
        assert_eq!(seen["type"], "snapshot");
        assert_eq!(seen["state"], json!({ "total": 0, "turn": 0 }));
        assert!(!seen["players"].to_string().contains(&watcher_id));
        ada.next().await;
        ada.act(add(4)).await;

        // The watcher sees the game move on, like a player does.
        assert_eq!(
            watcher.next().await["state"],
            json!({ "total": 4, "turn": 1 })
        );
    }

    #[sqlx::test]
    async fn a_watcher_cannot_play_but_stays_connected(pool: PgPool) {
        let app = app(pool);
        let (game_id, _) = started_game(&app).await;
        let (_, watcher_token) = app.register_user().await;
        let server = app.serve().await;
        let mut watcher = Client::sign_in(&server, &game_id, &watcher_token).await;
        watcher.next().await;

        watcher.act(add(1)).await;

        let error = watcher.next().await;
        assert_eq!(error["type"], "error");
        assert_eq!(error["code"], "not-a-player");
        // Nothing changed, and the socket still works.
        watcher.expect_silence().await;
    }

    #[sqlx::test]
    async fn a_watcher_who_joins_plays_on_the_connection_they_have(pool: PgPool) {
        let app = app(pool);
        let (_, creator_token) = app.register_user().await;
        let (joiner_id, joiner_token) = app.register_user().await;
        let game_id = app.create_game(&creator_token, "tally").await;
        let server = app.serve().await;
        let mut creator = Client::sign_in(&server, &game_id, &creator_token).await;
        let mut joiner = Client::sign_in(&server, &game_id, &joiner_token).await;
        creator.next().await;
        let waiting = joiner.next().await;
        assert_eq!(waiting["state"], Value::Null);
        // Watching a game that hasn't started: there is nothing to play yet.
        joiner.act(add(1)).await;
        assert_eq!(joiner.next().await["code"], "not-a-player");

        let reply = app.join_game(&joiner_token, &game_id).await;

        assert_eq!(reply.json["seat"], 1);
        let started = joiner.next().await;
        assert_eq!(started["players"][1], joiner_id.as_str());
        assert_eq!(started["state"], json!({ "total": 0, "turn": 0 }));
        creator.next().await;
        creator.act(add(2)).await;
        assert_eq!(
            joiner.next().await["state"],
            json!({ "total": 2, "turn": 1 })
        );
        joiner.act(add(3)).await;
        assert_eq!(
            joiner.next().await["state"],
            json!({ "total": 5, "turn": 0 })
        );
    }

    #[sqlx::test]
    async fn snapshots_carry_the_players_names(pool: PgPool) {
        let app = app(pool);
        let (_, creator_token) = app.register_user().await;
        let (_, joiner_token) = app.register_user().await;
        let named = app
            .send(
                Method::PATCH,
                "/api/me",
                Some(&bearer(&creator_token)),
                Some(json!({ "name": "Ada" })),
            )
            .await;
        assert_eq!(named.status, axum::http::StatusCode::OK);
        let game_id = app.create_game(&creator_token, "tally").await;
        let server = app.serve().await;
        let mut creator = Client::sign_in(&server, &game_id, &creator_token).await;

        assert_eq!(creator.next().await["playerNames"], json!(["Ada"]));

        // The joiner has no name yet. When they pick one, the creator hears at once, without
        // waiting for a move, and the game itself is as it was.
        app.join_game(&joiner_token, &game_id).await;
        let joined = creator.next().await;
        assert_eq!(joined["playerNames"], json!(["Ada", null]));
        app.send(
            Method::PATCH,
            "/api/me",
            Some(&bearer(&joiner_token)),
            Some(json!({ "name": "Grace" })),
        )
        .await;
        let renamed = creator.next().await;
        assert_eq!(renamed["playerNames"], json!(["Ada", "Grace"]));
        assert_eq!(renamed["revision"], joined["revision"]);
        assert_eq!(renamed["state"], joined["state"]);
    }

    #[sqlx::test]
    async fn a_new_name_reaches_everyone_connected_to_the_game_and_play_goes_on(pool: PgPool) {
        let app = app(pool);
        let (_, first) = app.register_user().await;
        let (_, second) = app.register_user().await;
        let (_, watcher_token) = app.register_user().await;
        let (_, other_player) = app.register_user().await;
        let game_id = app.create_game(&first, "tally").await;
        app.join_game(&second, &game_id).await;
        // A game of other people's, which must not hear about this.
        let (_, elsewhere) = app.register_user().await;
        let other_game = app.create_game(&other_player, "tally").await;
        app.join_game(&elsewhere, &other_game).await;
        let server = app.serve().await;
        let mut ada = Client::sign_in(&server, &game_id, &first).await;
        let mut grace = Client::sign_in(&server, &game_id, &second).await;
        let mut watcher = Client::sign_in(&server, &game_id, &watcher_token).await;
        let mut bystander = Client::sign_in(&server, &other_game, &other_player).await;
        for client in [&mut ada, &mut grace, &mut watcher, &mut bystander] {
            client.next().await;
        }

        let reply = app
            .send(
                Method::PATCH,
                "/api/me",
                Some(&bearer(&first)),
                Some(json!({ "name": "Ada" })),
            )
            .await;
        assert_eq!(reply.status, axum::http::StatusCode::OK);

        for client in [&mut ada, &mut grace, &mut watcher] {
            let snapshot = client.next().await;
            assert_eq!(snapshot["playerNames"], json!(["Ada", null]));
            assert_eq!(snapshot["revision"], 1);
        }
        bystander.expect_silence().await;
        // The name was not a move: the next action is revision 2 and carries the name along.
        ada.act(add(1)).await;
        let moved = grace.next().await;
        assert_eq!(moved["revision"], 2);
        assert_eq!(moved["playerNames"], json!(["Ada", null]));
    }

    #[sqlx::test]
    async fn saving_the_name_a_player_already_has_publishes_nothing(pool: PgPool) {
        let app = app(pool);
        let (_, first) = app.register_user().await;
        let (_, second) = app.register_user().await;
        let game_id = app.create_game(&first, "tally").await;
        app.join_game(&second, &game_id).await;
        let server = app.serve().await;
        let mut grace = Client::sign_in(&server, &game_id, &second).await;
        grace.next().await;

        rename(&app, &first, "Ada").await;
        assert_eq!(grace.next().await["playerNames"], json!(["Ada", null]));
        rename(&app, &first, "Ada").await;

        grace.expect_silence().await;
    }

    #[sqlx::test]
    async fn an_unknown_game_is_closed_as_not_found(pool: PgPool) {
        let app = app(pool);
        let (_, token) = app.register_user().await;
        let server = app.serve().await;

        let mut client = Client::sign_in(&server, "nosuchgame22", &token).await;

        assert_eq!(client.closed().await, close::NOT_FOUND);
    }

    #[sqlx::test]
    async fn a_player_is_sent_the_game_as_it_is(pool: PgPool) {
        let app = app(pool);
        let (game_id, [(first, token), _]) = started_game(&app).await;
        let server = app.serve().await;

        let mut client = Client::sign_in(&server, &game_id, &token).await;

        let snapshot = client.next().await;
        assert_eq!(snapshot["type"], "snapshot");
        assert_eq!(snapshot["gameId"], game_id.as_str());
        assert_eq!(snapshot["kind"], "tally");
        assert_eq!(snapshot["revision"], 1);
        assert_eq!(snapshot["stateVersion"], 1);
        assert_eq!(snapshot["players"][0], first.as_str());
        assert_eq!(snapshot["state"], json!({ "total": 0, "turn": 0 }));
    }

    #[sqlx::test]
    async fn the_player_who_waits_hears_when_the_game_starts(pool: PgPool) {
        let app = app(pool);
        let (_, creator_token) = app.register_user().await;
        let (_, joiner_token) = app.register_user().await;
        let game_id = app.create_game(&creator_token, "tally").await;
        let server = app.serve().await;
        let mut client = Client::sign_in(&server, &game_id, &creator_token).await;
        let waiting = client.next().await;
        assert_eq!(waiting["state"], Value::Null);
        assert_eq!(waiting["players"].as_array().unwrap().len(), 1);

        app.join_game(&joiner_token, &game_id).await;

        let started = client.next().await;
        assert_eq!(started["revision"], 1);
        assert_eq!(started["players"].as_array().unwrap().len(), 2);
        assert_eq!(started["state"], json!({ "total": 0, "turn": 0 }));
    }

    #[sqlx::test]
    async fn an_accepted_action_reaches_both_players(pool: PgPool) {
        let app = app(pool);
        let (game_id, [(_, first), (_, second)]) = started_game(&app).await;
        let server = app.serve().await;
        let mut ada = Client::sign_in(&server, &game_id, &first).await;
        let mut grace = Client::sign_in(&server, &game_id, &second).await;
        ada.next().await;
        grace.next().await;

        ada.act(add(4)).await;

        for client in [&mut ada, &mut grace] {
            let snapshot = client.next().await;
            assert_eq!(snapshot["revision"], 2);
            assert_eq!(snapshot["state"], json!({ "total": 4, "turn": 1 }));
        }
    }

    #[sqlx::test]
    async fn a_refused_action_gets_an_error_for_the_sender_only(pool: PgPool) {
        let app = app(pool);
        let (game_id, [(_, first), (_, second)]) = started_game(&app).await;
        let server = app.serve().await;
        let mut ada = Client::sign_in(&server, &game_id, &first).await;
        let mut grace = Client::sign_in(&server, &game_id, &second).await;
        ada.next().await;
        grace.next().await;

        // It is Ada's turn.
        grace.act(add(1)).await;

        assert_eq!(
            grace.next().await,
            json!({ "type": "error", "code": "rejected", "message": "not your turn" })
        );
        ada.expect_silence().await;
        grace.expect_silence().await;
    }

    #[sqlx::test]
    async fn the_socket_stays_open_after_an_error(pool: PgPool) {
        let app = app(pool);
        let (game_id, [(_, first), _]) = started_game(&app).await;
        let server = app.serve().await;
        let mut ada = Client::sign_in(&server, &game_id, &first).await;
        ada.next().await;

        ada.act(add(-1)).await;
        assert_eq!(ada.next().await["code"], "rejected");
        ada.act(add(2)).await;

        assert_eq!(ada.next().await["state"], json!({ "total": 2, "turn": 1 }));
    }

    #[sqlx::test]
    async fn messages_that_make_no_sense_get_an_error(pool: PgPool) {
        let app = app(pool);
        let (game_id, [(_, first), _]) = started_game(&app).await;
        let server = app.serve().await;
        let mut ada = Client::sign_in(&server, &game_id, &first).await;
        ada.next().await;

        for nonsense in [
            json!({ "type": "dance" }),
            json!({ "type": "action" }),
            json!([1, 2]),
            json!({ "type": "hello", "token": first }),
        ] {
            ada.say(nonsense.clone()).await;
            assert_eq!(ada.next().await["code"], "bad-message", "{nonsense}");
        }
        // A well-formed action of a shape the game doesn't know is the game's to refuse.
        ada.act(json!({ "type": "multiply" })).await;
        assert_eq!(ada.next().await["code"], "rejected");
    }

    #[sqlx::test]
    async fn an_action_before_the_game_starts_gets_not_started(pool: PgPool) {
        let app = app(pool);
        let (_, token) = app.register_user().await;
        let game_id = app.create_game(&token, "tally").await;
        let server = app.serve().await;
        let mut client = Client::sign_in(&server, &game_id, &token).await;
        client.next().await;

        client.act(add(1)).await;

        assert_eq!(client.next().await["code"], "not-started");
    }

    #[sqlx::test]
    async fn a_game_is_loaded_from_the_database_when_a_player_opens_it(pool: PgPool) {
        let before = app(pool.clone());
        let (game_id, [(_, first), (_, second)]) = started_game(&before).await;
        let old_server = before.serve().await;
        let mut ada = Client::sign_in(&old_server, &game_id, &first).await;
        ada.next().await;
        ada.act(add(7)).await;
        ada.next().await;
        drop((ada, old_server));

        // A new app has no rooms in memory, as after a restart.
        let after = app(pool);
        let server = after.serve().await;
        let mut grace = Client::sign_in(&server, &game_id, &second).await;

        let snapshot = grace.next().await;
        assert_eq!(snapshot["revision"], 2);
        assert_eq!(snapshot["state"], json!({ "total": 7, "turn": 1 }));
        // Grace can carry on from there.
        grace.act(add(1)).await;
        assert_eq!(
            grace.next().await["state"],
            json!({ "total": 8, "turn": 0 })
        );
    }

    #[sqlx::test]
    async fn a_person_and_the_bot_take_turns_at_long_backgammon_over_the_socket(pool: PgPool) {
        // The real games, not a stand-in: this is what the site does when someone picks the bot.
        let app = TestApp::new(pool, crate::game::registry());
        let server = app.serve().await;
        let (_, token) = app.register_user().await;
        let created = app.create_bot_game(&token, "long-backgammon").await;
        let game_id = created.json["gameId"].as_str().unwrap().to_owned();
        let mut client = Client::sign_in(&server, &game_id, &token).await;

        // Play three turns by always taking the first step the server offers. Whenever it is
        // the person's turn and there is something to do, do it; otherwise the bot is playing,
        // and the next snapshot is its doing.
        let mut snapshot = client.next().await;
        for _ in 0..400 {
            let state = &snapshot["state"];
            if state["turns"][0].as_u64() >= Some(3) {
                break;
            }
            assert_ne!(state["phase"]["type"], "over", "the game ended too soon");
            if state["turn"] == 0 {
                match state["phase"]["type"].as_str().unwrap() {
                    "roll" => client.act(json!({ "type": "roll" })).await,
                    _ => {
                        let step = &state["legal"][0];
                        client
                            .act(
                                json!({ "type": "move", "from": step["from"], "die": step["die"] }),
                            )
                            .await;
                    }
                }
            }
            snapshot = client.next().await;
        }

        let state = &snapshot["state"];
        assert_eq!(state["turns"][0], 3, "the person played three turns");
        // The bot answered every one of them, and began if it was White.
        let bot_turns = state["turns"][1].as_u64().unwrap();
        assert!(bot_turns >= 2, "the bot played only {bot_turns} turns");
        assert_eq!(snapshot["players"][1], crate::bot::BOT_USER.to_string());
        assert_eq!(snapshot["playerNames"], json!([null, "Bot"]));
    }

    #[sqlx::test]
    async fn a_rematch_reaches_the_other_player_as_a_snapshot_on_the_socket_they_have(
        pool: PgPool,
    ) {
        let app = TestApp::new(pool, Games::default().with::<Quick>());
        let (game_id, [(_, ada), (_, grace)]) = app.finished_quick_game().await;
        let server = app.serve().await;
        let mut ada_socket = Client::sign_in(&server, &game_id, &ada).await;
        let mut grace_socket = Client::sign_in(&server, &game_id, &grace).await;
        // Over, and nobody has asked yet.
        assert_eq!(ada_socket.next().await["rematch"], json!(null));
        grace_socket.next().await;

        app.ask_rematch(&ada, &game_id).await;

        for socket in [&mut ada_socket, &mut grace_socket] {
            let seen = socket.next().await;
            assert_eq!(seen["type"], "snapshot");
            assert_eq!(seen["rematch"], json!({ "type": "offered", "by": 0 }));
            assert_eq!(seen["state"], json!({ "over": true }));
        }
        let reply = app.ask_rematch(&grace, &game_id).await;
        let next = reply.json["rematch"]["gameId"].as_str().unwrap().to_owned();
        for socket in [&mut ada_socket, &mut grace_socket] {
            let seen = socket.next().await;
            assert_eq!(
                seen["rematch"],
                json!({ "type": "accepted", "gameId": next })
            );
        }
        // Both go on to the new game, where it is about to begin.
        let mut following = Client::sign_in(&server, &next, &ada).await;
        let seen = following.next().await;
        assert_eq!(seen["state"], json!({ "over": false }));
        assert_eq!(seen["rematch"], json!(null));
    }
}
