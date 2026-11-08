//! Helpers for tests that drive the whole app through its router.

use std::{net::SocketAddr, time::Duration};

use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Method, Request, StatusCode, header},
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};
use tower::ServiceExt;

use crate::{
    AppState, app,
    game::{Game, Games, Rejection, StateError},
    room::Rooms,
};

pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    /// The JSON body, or `Null` if there isn't one.
    pub json: Value,
}

/// An app that keeps its state (in particular its rooms) between requests.
pub struct TestApp {
    router: Router,
}

impl TestApp {
    pub fn new(pool: PgPool, games: Games) -> Self {
        // Rooms hold a clone of the pool, and `#[sqlx::test]` only gets its connections back
        // for cleaning up once every clone is gone. So rooms must not linger after a test.
        let rooms = Rooms::with_idle_grace(pool.clone(), games, Duration::from_millis(100));
        let router = app(AppState { pool, rooms });
        Self { router }
    }

    /// Sends one request. `authorization` is the whole header value, e.g. `Bearer abc`.
    pub async fn send(
        &self,
        method: Method,
        uri: &str,
        authorization: Option<&str>,
        json: Option<Value>,
    ) -> Reply {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(value) = authorization {
            builder = builder.header(header::AUTHORIZATION, value);
        }
        let body = match json {
            Some(json) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(json.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        Reply {
            status: parts.status,
            headers: parts.headers,
            json: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        }
    }

    /// Registers a user. Returns its id and access token.
    pub async fn register_user(&self) -> (String, String) {
        let reply = self.send(Method::POST, "/api/register", None, None).await;
        assert_eq!(reply.status, StatusCode::CREATED);
        (
            reply.json["userId"].as_str().unwrap().to_owned(),
            reply.json["accessToken"].as_str().unwrap().to_owned(),
        )
    }

    /// Creates a game as the token's user. Returns its id.
    pub async fn create_game(&self, token: &str, kind: &str) -> String {
        let reply = self
            .send(
                Method::POST,
                "/api/games",
                Some(&bearer(token)),
                Some(json!({ "kind": kind })),
            )
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.json);
        reply.json["gameId"].as_str().unwrap().to_owned()
    }

    pub async fn join_game(&self, token: &str, game_id: &str) -> Reply {
        let uri = format!("/api/games/{game_id}/join");
        self.send(Method::POST, &uri, Some(&bearer(token)), None)
            .await
    }

    /// Serves the app on a free loopback port, for tests that need a real connection.
    /// The server stops when the returned value is dropped.
    pub async fn serve(&self) -> Server {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = self.router.clone();
        let task = tokio::spawn(async move { axum::serve(listener, router).await });
        Server { addr, task }
    }
}

/// A running test server. It holds the app's pool, so it must not outlive its test
/// (see [`TestApp::new`]), and dropping it stops it.
pub struct Server {
    addr: SocketAddr,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Sends one request to a fresh app that offers no games.
pub async fn send(
    pool: &PgPool,
    method: Method,
    uri: &str,
    authorization: Option<&str>,
    json: Option<Value>,
) -> Reply {
    TestApp::new(pool.clone(), Games::default())
        .send(method, uri, authorization, json)
        .await
}

/// Registers a user. Returns its id and access token.
pub async fn register_user(pool: &PgPool) -> (String, String) {
    TestApp::new(pool.clone(), Games::default())
        .register_user()
        .await
}

pub fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// A WebSocket client for the server started by [`TestApp::serve`].
pub struct Client {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

/// Nothing in these tests should take this long. It only turns a hang into a failure.
const PATIENCE: Duration = Duration::from_secs(5);

impl Client {
    pub async fn connect(server: &Server, game_id: &str) -> Self {
        let url = format!("ws://{}/api/games/{game_id}/ws", server.addr);
        let (socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        Self { socket }
    }

    /// Connects and signs in with the token.
    pub async fn sign_in(server: &Server, game_id: &str, token: &str) -> Self {
        let mut client = Self::connect(server, game_id).await;
        client.say(json!({ "type": "hello", "token": token })).await;
        client
    }

    pub async fn say(&mut self, message: Value) {
        self.socket
            .send(Message::text(message.to_string()))
            .await
            .unwrap();
    }

    pub async fn act(&mut self, action: Value) {
        self.say(json!({ "type": "action", "action": action }))
            .await;
    }

    /// The next message from the server.
    pub async fn next(&mut self) -> Value {
        loop {
            let message = timeout(PATIENCE, self.socket.next())
                .await
                .expect("no message from the server");
            match message {
                Some(Ok(Message::Text(text))) => return serde_json::from_str(&text).unwrap(),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                other => panic!("expected a message, got {other:?}"),
            }
        }
    }

    /// Waits for the server to close the socket. Returns the close code.
    pub async fn closed(&mut self) -> u16 {
        loop {
            let message = timeout(PATIENCE, self.socket.next())
                .await
                .expect("the server did not close the socket");
            match message {
                Some(Ok(Message::Close(Some(frame)))) => return frame.code.into(),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                other => panic!("expected a close frame, got {other:?}"),
            }
        }
    }

    /// Fails if the server sends anything within a short while.
    pub async fn expect_silence(&mut self) {
        if let Ok(message) = timeout(Duration::from_millis(200), self.socket.next()).await {
            panic!("expected silence, got {message:?}");
        }
    }
}

/// Polls until `condition` holds, for things that happen on other tasks.
pub async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    while !condition() {
        assert!(tokio::time::Instant::now() < deadline, "never: {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// Games for testing the room system.

/// Two players take turns adding to a total. Seat 0 begins.
pub struct Tally;

#[derive(Serialize, Deserialize)]
pub struct TallyState {
    pub total: i64,
    pub turn: usize,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TallyAction {
    Add { amount: i64 },
}

/// The turn rules shared by both versions: the next seat to move.
fn tally_turn(turn: usize, seat: usize, amount: i64) -> Result<usize, Rejection> {
    if seat != turn {
        return Err(Rejection::new("not your turn"));
    }
    if amount <= 0 {
        return Err(Rejection::new("the amount must be positive"));
    }
    Ok(1 - seat)
}

impl Game for Tally {
    const KIND: &'static str = "tally";
    const PLAYERS: usize = 2;
    const STATE_VERSION: u32 = 1;
    type State = TallyState;
    type Action = TallyAction;

    fn start() -> TallyState {
        TallyState { total: 0, turn: 0 }
    }

    fn apply(
        state: &TallyState,
        seat: usize,
        action: TallyAction,
    ) -> Result<TallyState, Rejection> {
        let TallyAction::Add { amount } = action;
        let turn = tally_turn(state.turn, seat, amount)?;
        Ok(TallyState {
            total: state.total + amount,
            turn,
        })
    }
}

/// The same game after a later release renamed `total` to `sum`.
pub struct TallyV2;

#[derive(Serialize, Deserialize)]
pub struct TallyV2State {
    pub sum: i64,
    pub turn: usize,
}

impl Game for TallyV2 {
    const KIND: &'static str = "tally";
    const PLAYERS: usize = 2;
    const STATE_VERSION: u32 = 2;
    type State = TallyV2State;
    type Action = TallyAction;

    fn start() -> TallyV2State {
        TallyV2State { sum: 0, turn: 0 }
    }

    fn apply(
        state: &TallyV2State,
        seat: usize,
        action: TallyAction,
    ) -> Result<TallyV2State, Rejection> {
        let TallyAction::Add { amount } = action;
        let turn = tally_turn(state.turn, seat, amount)?;
        Ok(TallyV2State {
            sum: state.sum + amount,
            turn,
        })
    }

    fn upgrade(from_version: u32, mut state: Value) -> Result<Value, StateError> {
        match from_version {
            1 => {
                let total = state
                    .as_object_mut()
                    .and_then(|state| state.remove("total"))
                    .ok_or_else(|| StateError::new("a version 1 state has a total"))?;
                state["sum"] = total;
                Ok(state)
            }
            other => Err(StateError::new(format!("no upgrade from version {other}"))),
        }
    }
}

/// A game for one player, which counts their actions.
pub struct Solo;

#[derive(Serialize, Deserialize)]
pub struct SoloState {
    pub count: u32,
}

impl Game for Solo {
    const KIND: &'static str = "solo";
    const PLAYERS: usize = 1;
    const STATE_VERSION: u32 = 1;
    type State = SoloState;
    type Action = Value;

    fn start() -> SoloState {
        SoloState { count: 0 }
    }

    /// Over after three actions.
    fn is_over(state: &SoloState) -> bool {
        state.count >= 3
    }

    fn apply(state: &SoloState, _seat: usize, _action: Value) -> Result<SoloState, Rejection> {
        Ok(SoloState {
            count: state.count + 1,
        })
    }
}
