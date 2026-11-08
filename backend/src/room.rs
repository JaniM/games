//! Rooms: the live copy of every game somebody is playing.
//!
//! A game lives in the database. While somebody uses it, it is also loaded into a
//! **room**: a task that owns the game's state and handles one request at a time, so
//! changes happen in a single order. A game is loaded when it is created, joined or
//! connected to, and a game that isn't in memory is loaded from the database first.
//!
//! Every change goes **to the database first**. Only when it is saved does the room
//! adopt it and publish a [`Snapshot`] of the whole game to everyone connected, so
//! what clients see has always been stored. If a save fails, the room can no longer
//! tell what the database holds. It shuts down and the next request loads the truth.
//!
//! A room stays in memory as long as anyone is [`Connection`]ed to it, and for
//! [`IDLE_GRACE`] after the last request or disconnection. The grace period covers the
//! gap between creating or joining over HTTP and connecting the socket, and a page reload.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use sqlx::PgPool;
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;

use crate::game::{Engine, Games, Live};

/// How long a room with nobody connected stays in memory.
pub const IDLE_GRACE: Duration = Duration::from_secs(30);

/// Asking a room that is shutting down gets `Gone`, and the next attempt starts a
/// fresh one. Two attempts only fail if a room shuts down twice in a row.
const ATTEMPTS: usize = 3;

/// Everything about a game that clients see. A room publishes a new one after every
/// change, so a client never needs more than the latest.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub game_id: Uuid,
    pub kind: &'static str,
    /// Counts the changes since the game was created. Rises by one for each
    /// player who joins and each action played, so clients can tell which of two snapshots is newer.
    pub revision: i64,
    /// The layout version of `state`. The server only sends the current one.
    pub state_version: u32,
    /// The players' user ids, by seat.
    pub players: Vec<Uuid>,
    /// Null until every seat is taken.
    pub state: Option<Value>,
}

/// Why a request to a room failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomError {
    NotFound,
    /// The user has no seat in the game.
    NotAPlayer,
    /// Every seat is taken.
    Full,
    /// An action came before the last seat was taken.
    NotStarted,
    /// The game's rules refused the action. The reason is for the player.
    Rejected(String),
    /// Our fault. The details are in the log.
    Internal,
    /// The room shut down before it handled the request.
    Gone,
}

/// The rooms that are in memory, and the way to reach them.
#[derive(Clone)]
pub struct Rooms {
    shared: Arc<Shared>,
}

struct Shared {
    pool: PgPool,
    games: Games,
    idle_grace: Duration,
    /// How to reach each room. An entry whose channel is closed is a room that has shut
    /// down, and counts as absent. Rooms remove their own entry on the way out.
    open: Mutex<HashMap<Uuid, mpsc::UnboundedSender<Command>>>,
}

impl Rooms {
    pub fn new(pool: PgPool, games: Games) -> Self {
        Self::with_idle_grace(pool, games, IDLE_GRACE)
    }

    pub fn with_idle_grace(pool: PgPool, games: Games, idle_grace: Duration) -> Self {
        Self {
            shared: Arc::new(Shared {
                pool,
                games,
                idle_grace,
                open: Mutex::default(),
            }),
        }
    }

    pub fn games(&self) -> &Games {
        &self.shared.games
    }

    /// Creates a game of the given kind with `creator` in seat 0, and loads it.
    pub async fn create(&self, engine: &Arc<dyn Engine>, creator: Uuid) -> Result<Uuid, RoomError> {
        // A game for one player has no one to wait for.
        let state = match engine.players() {
            1 => to_json(Some(engine.start().as_ref()))?,
            _ => None,
        };
        let id = self
            .insert(engine.as_ref(), creator, state)
            .await
            .map_err(|err| {
                tracing::error!(%err, "could not create a game");
                RoomError::Internal
            })?;
        // Loading it now is what makes it a room, ready for the socket that follows.
        self.shared.room(id);
        Ok(id)
    }

    async fn insert(
        &self,
        engine: &dyn Engine,
        creator: Uuid,
        state: Option<Value>,
    ) -> Result<Uuid, sqlx::Error> {
        let mut tx = self.shared.pool.begin().await?;
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO games (kind, state_version, state) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(engine.kind())
        .bind(engine.state_version() as i32)
        .bind(state)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO game_players (game_id, seat, user_id) VALUES ($1, 0, $2)")
            .bind(id)
            .bind(creator)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(id)
    }

    /// Seats `user` in the game and returns the seat. A user who already has a seat gets
    /// the same one again. Taking the last seat starts the game.
    pub async fn join(&self, game_id: Uuid, user: Uuid) -> Result<usize, RoomError> {
        let (seat, _) = self
            .request(game_id, |reply| Command::Join { user, reply })
            .await?;
        Ok(seat)
    }

    /// Connects `user`, who must have a seat, to the game's room. The room stays in
    /// memory until the connection is dropped.
    pub async fn connect(&self, game_id: Uuid, user: Uuid) -> Result<Connection, RoomError> {
        let (connected, commands) = self
            .request(game_id, |reply| Command::Connect { user, reply })
            .await?;
        Ok(Connection {
            seat: connected.seat,
            snapshots: connected.snapshots,
            commands,
        })
    }

    /// Whether the game is in memory.
    #[cfg(test)]
    pub fn is_open(&self, game_id: Uuid) -> bool {
        let open = self.shared.open();
        open.get(&game_id)
            .is_some_and(|commands| !commands.is_closed())
    }

    /// Sends a command to the game's room, loading the room if needed, and returns the
    /// answer with the way to reach the room again.
    async fn request<T>(
        &self,
        game_id: Uuid,
        command: impl Fn(oneshot::Sender<Result<T, RoomError>>) -> Command,
    ) -> Result<(T, mpsc::UnboundedSender<Command>), RoomError> {
        for _ in 0..ATTEMPTS {
            let commands = self.shared.room(game_id);
            let (reply, answer) = oneshot::channel();
            if commands.send(command(reply)).is_err() {
                continue; // It shut down since we looked it up. Nothing was sent.
            }
            match answer.await {
                Ok(Ok(value)) => return Ok((value, commands)),
                Ok(Err(RoomError::Gone)) => continue, // Shut down before handling it.
                Ok(Err(err)) => return Err(err),
                // The room died with our request in hand. If it was a join, we can't
                // know whether it happened, so don't do it again.
                Err(_) => return Err(RoomError::Internal),
            }
        }
        Err(RoomError::Internal)
    }
}

impl Shared {
    fn open(&self) -> MutexGuard<'_, HashMap<Uuid, mpsc::UnboundedSender<Command>>> {
        // Nothing under this lock can panic halfway, so a poisoned lock holds valid data.
        self.open.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The way to reach the game's room, starting the room (which loads the game) if it
    /// isn't there. Returns before the game is loaded; requests wait in line.
    fn room(self: &Arc<Self>, id: Uuid) -> mpsc::UnboundedSender<Command> {
        let mut open = self.open();
        if let Some(commands) = open.get(&id)
            && !commands.is_closed()
        {
            return commands.clone();
        }
        let (commands, inbox) = mpsc::unbounded_channel();
        open.insert(id, commands.clone());
        tokio::spawn(run(self.clone(), id, inbox));
        commands
    }

    /// Drops the entry of a room that has shut down. A newer room under the same id stays.
    fn forget(&self, id: Uuid) {
        let mut open = self.open();
        if open.get(&id).is_some_and(|commands| commands.is_closed()) {
            open.remove(&id);
        }
    }
}

/// The life of a room: load the game, serve requests, and on the way out turn away
/// whoever is still in line.
async fn run(shared: Arc<Shared>, id: Uuid, mut inbox: mpsc::UnboundedReceiver<Command>) {
    let outcome = match Room::load(&shared, id).await {
        Ok(mut room) => {
            tracing::debug!(game = %id, "game loaded");
            room.serve(&mut inbox, shared.idle_grace).await;
            tracing::debug!(game = %id, "game unloaded");
            RoomError::Gone
        }
        Err(err) => err,
    };
    // Closing first makes new requests start a fresh room instead of joining the queue
    // behind us. Whatever got in before that is answered here.
    inbox.close();
    shared.forget(id);
    while let Ok(command) = inbox.try_recv() {
        command.fail(outcome.clone());
    }
}

enum Command {
    Connect {
        user: Uuid,
        reply: oneshot::Sender<Result<Connected, RoomError>>,
    },
    Join {
        user: Uuid,
        reply: oneshot::Sender<Result<usize, RoomError>>,
    },
    Act {
        seat: usize,
        action: Value,
        reply: oneshot::Sender<Result<(), RoomError>>,
    },
}

impl Command {
    /// Answers the command with an error. Nobody listening is fine.
    fn fail(self, err: RoomError) {
        match self {
            Self::Connect { reply, .. } => _ = reply.send(Err(err)),
            Self::Join { reply, .. } => _ = reply.send(Err(err)),
            Self::Act { reply, .. } => _ = reply.send(Err(err)),
        }
    }
}

struct Connected {
    seat: usize,
    snapshots: watch::Receiver<Arc<Snapshot>>,
}

/// A player's link to a room. Keeps the room in memory until dropped.
pub struct Connection {
    seat: usize,
    snapshots: watch::Receiver<Arc<Snapshot>>,
    commands: mpsc::UnboundedSender<Command>,
}

impl Connection {
    /// The newest snapshot. [`Connection::changed`] waits for ones newer than this.
    pub fn latest(&mut self) -> Arc<Snapshot> {
        self.snapshots.borrow_and_update().clone()
    }

    /// Waits for a snapshot newer than the last one seen and returns the newest. Only the
    /// latest matters, so a slow reader skips the ones in between. Returns `None` when the
    /// room has shut down; connect again to get a fresh one.
    pub async fn changed(&mut self) -> Option<Arc<Snapshot>> {
        self.snapshots.changed().await.ok()?;
        Some(self.latest())
    }

    /// Plays an action as this connection's player. On success the new state has been
    /// saved and published, to this connection too.
    pub async fn act(&self, action: Value) -> Result<(), RoomError> {
        let (reply, answer) = oneshot::channel();
        let command = Command::Act {
            seat: self.seat,
            action,
            reply,
        };
        self.commands.send(command).map_err(|_| RoomError::Gone)?;
        answer.await.map_err(|_| RoomError::Internal)?
    }
}

/// The state behind a room, owned by its task.
struct Room {
    pool: PgPool,
    engine: Arc<dyn Engine>,
    id: Uuid,
    /// By seat.
    players: Vec<Uuid>,
    /// The game, in its own type. It becomes JSON only to be stored and sent, and is never
    /// read back from JSON while the room is up. Null until every seat is taken.
    live: Option<Box<dyn Live>>,
    revision: i64,
    snapshots: watch::Sender<Arc<Snapshot>>,
    /// Set when a save failed: memory can't be trusted any more, so the room must stop.
    stale: bool,
}

impl Room {
    async fn load(shared: &Shared, id: Uuid) -> Result<Self, RoomError> {
        let row: Option<(String, i32, Option<Value>, i64)> =
            sqlx::query_as("SELECT kind, state_version, state, revision FROM games WHERE id = $1")
                .bind(id)
                .fetch_optional(&shared.pool)
                .await
                .map_err(|err| internal(err, "could not load a game"))?;
        let (kind, state_version, state, revision) = row.ok_or(RoomError::NotFound)?;
        let players: Vec<Uuid> =
            sqlx::query_scalar("SELECT user_id FROM game_players WHERE game_id = $1 ORDER BY seat")
                .bind(id)
                .fetch_all(&shared.pool)
                .await
                .map_err(|err| internal(err, "could not load a game's players"))?;

        let Some(engine) = shared.games.get(&kind) else {
            return Err(internal(
                format!("game {id}"),
                "stored game of unknown kind",
            ));
        };
        // The stored state is brought up to date here. It is saved in the new layout
        // along with the next change.
        let live = state
            .map(|state| engine.load(state_version as u32, state))
            .transpose()
            .map_err(|err| internal(err, "could not read a stored game state"))?;
        let state = to_json(live.as_deref())?;

        let snapshot = Snapshot {
            game_id: id,
            kind: engine.kind(),
            revision,
            state_version: engine.state_version(),
            players: players.clone(),
            state,
        };
        Ok(Self {
            pool: shared.pool.clone(),
            engine: engine.clone(),
            id,
            players,
            live,
            revision,
            // Nobody is connected yet. The receiver the channel starts with is dropped at once.
            snapshots: watch::channel(Arc::new(snapshot)).0,
            stale: false,
        })
    }

    /// Handles requests until the room has been idle for `idle_grace` with nobody
    /// connected, or can no longer trust its state.
    async fn serve(&mut self, inbox: &mut mpsc::UnboundedReceiver<Command>, idle_grace: Duration) {
        loop {
            let command = if self.snapshots.receiver_count() > 0 {
                tokio::select! {
                    command = inbox.recv() => command,
                    // The last connection left. Look again to start the grace period.
                    _ = self.snapshots.closed() => continue,
                }
            } else {
                match tokio::time::timeout(idle_grace, inbox.recv()).await {
                    Ok(command) => command,
                    Err(_) => return,
                }
            };
            let Some(command) = command else { return };
            self.handle(command).await;
            if self.stale {
                return;
            }
        }
    }

    async fn handle(&mut self, command: Command) {
        match command {
            Command::Connect { user, reply } => _ = reply.send(self.connect(user)),
            Command::Join { user, reply } => _ = reply.send(self.join(user).await),
            Command::Act {
                seat,
                action,
                reply,
            } => _ = reply.send(self.act(seat, action).await),
        }
    }

    fn connect(&self, user: Uuid) -> Result<Connected, RoomError> {
        let seat = self.seat_of(user).ok_or(RoomError::NotAPlayer)?;
        Ok(Connected {
            seat,
            snapshots: self.snapshots.subscribe(),
        })
    }

    async fn join(&mut self, user: Uuid) -> Result<usize, RoomError> {
        if let Some(seat) = self.seat_of(user) {
            return Ok(seat);
        }
        if self.players.len() >= self.engine.players() {
            return Err(RoomError::Full);
        }
        let seat = self.players.len();
        // The last seat starts the game.
        let live = (seat + 1 == self.engine.players()).then(|| self.engine.start());
        let state = to_json(live.as_deref())?;

        self.save(Some((seat, user)), state.as_ref()).await?;
        self.players.push(user);
        self.live = live;
        self.revision += 1;
        self.publish(state);
        Ok(seat)
    }

    async fn act(&mut self, seat: usize, action: Value) -> Result<(), RoomError> {
        let Some(live) = &self.live else {
            return Err(RoomError::NotStarted);
        };
        let next = live
            .apply(seat, action)
            .map_err(|rejection| RoomError::Rejected(rejection.reason().to_owned()))?;
        let state = to_json(Some(next.as_ref()))?;

        self.save(None, state.as_ref()).await?;
        self.live = Some(next);
        self.revision += 1;
        self.publish(state);
        Ok(())
    }

    fn seat_of(&self, user: Uuid) -> Option<usize> {
        self.players.iter().position(|player| *player == user)
    }

    /// Writes a change to the database as the next revision: the state, and the player
    /// who joined with it if there is one. The room is stale if this fails.
    async fn save(
        &mut self,
        new_player: Option<(usize, Uuid)>,
        state: Option<&Value>,
    ) -> Result<(), RoomError> {
        let change = Change {
            game_id: self.id,
            from_revision: self.revision,
            state_version: self.engine.state_version() as i32,
            new_player,
            state,
        };
        // Not a method: the future may only borrow what it needs, so that a game's
        // state doesn't have to be `Sync`.
        let saved = write(&self.pool, change).await;
        saved.map_err(|reason| {
            self.stale = true;
            internal(reason, "could not save a game, so dropping it from memory")
        })
    }

    /// Tells everyone connected about the game as it now is. `state` is the game's JSON.
    fn publish(&self, state: Option<Value>) {
        self.snapshots.send_replace(Arc::new(Snapshot {
            game_id: self.id,
            kind: self.engine.kind(),
            revision: self.revision,
            state_version: self.engine.state_version(),
            players: self.players.clone(),
            state,
        }));
    }
}

/// The game's state as JSON, to store and to send. Null for a game that hasn't started.
fn to_json(live: Option<&dyn Live>) -> Result<Option<Value>, RoomError> {
    live.map(|live| live.to_json())
        .transpose()
        .map_err(|err| internal(err, "could not write a game state as JSON"))
}

/// Logs what went wrong and gives the error that goes to the requester.
fn internal(err: impl std::fmt::Display, context: &str) -> RoomError {
    tracing::error!(%err, "{context}");
    RoomError::Internal
}

/// One change to a stored game.
struct Change<'a> {
    game_id: Uuid,
    /// The revision the change builds on.
    from_revision: i64,
    state_version: i32,
    new_player: Option<(usize, Uuid)>,
    state: Option<&'a Value>,
}

/// Stores a change in one transaction, as revision `from_revision + 1`. Fails if the game
/// is no longer at `from_revision`, i.e. somebody else changed it. The error is for the log.
async fn write(pool: &PgPool, change: Change<'_>) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|err| err.to_string())?;
    if let Some((seat, user)) = change.new_player {
        sqlx::query("INSERT INTO game_players (game_id, seat, user_id) VALUES ($1, $2, $3)")
            .bind(change.game_id)
            .bind(seat as i16)
            .bind(user)
            .execute(&mut *tx)
            .await
            .map_err(|err| err.to_string())?;
    }
    let updated = sqlx::query(
        "UPDATE games
         SET state = $2, state_version = $3, revision = revision + 1, updated_at = now()
         WHERE id = $1 AND revision = $4",
    )
    .bind(change.game_id)
    .bind(change.state)
    .bind(change.state_version)
    .bind(change.from_revision)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?
    .rows_affected();
    if updated != 1 {
        return Err(format!(
            "game is no longer at revision {}",
            change.from_revision
        ));
    }
    tx.commit().await.map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_util::{Solo, Tally, TallyV2, TestApp, eventually};

    /// Short enough to wait out in a test.
    const GRACE: Duration = Duration::from_millis(50);

    fn tally() -> Games {
        Games::default().with::<Tally>().with::<Solo>()
    }

    fn rooms(pool: &PgPool, games: Games) -> Rooms {
        Rooms::with_idle_grace(pool.clone(), games, GRACE)
    }

    async fn user(pool: &PgPool) -> Uuid {
        let app = TestApp::new(pool.clone(), Games::default());
        app.register_user().await.0.parse().unwrap()
    }

    /// A tally game with `first` in seat 0 and `second` in seat 1.
    async fn started_game(rooms: &Rooms, first: Uuid, second: Uuid) -> Uuid {
        let id = waiting_game(rooms, first).await;
        rooms.join(id, second).await.unwrap();
        id
    }

    async fn waiting_game(rooms: &Rooms, creator: Uuid) -> Uuid {
        let engine = rooms.games().get("tally").unwrap().clone();
        rooms.create(&engine, creator).await.unwrap()
    }

    fn add(amount: i64) -> Value {
        json!({ "type": "add", "amount": amount })
    }

    /// The newest snapshot, once it has arrived.
    async fn next(connection: &mut Connection) -> Arc<Snapshot> {
        tokio::time::timeout(Duration::from_secs(5), connection.changed())
            .await
            .expect("no new snapshot")
            .expect("the room shut down")
    }

    async fn assert_quiet(connection: &mut Connection) {
        let waited = tokio::time::timeout(Duration::from_millis(150), connection.changed()).await;
        assert!(waited.is_err(), "unexpected snapshot: {waited:?}");
    }

    /// The database's revision, state version and state of a game.
    async fn stored(pool: &PgPool, id: Uuid) -> (i64, i32, Option<Value>) {
        sqlx::query_as("SELECT revision, state_version, state FROM games WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[sqlx::test]
    async fn a_created_game_is_loaded_into_memory(pool: PgPool) {
        let rooms = Rooms::new(pool.clone(), tally());
        let creator = user(&pool).await;

        let id = waiting_game(&rooms, creator).await;

        assert!(rooms.is_open(id));
    }

    #[sqlx::test]
    async fn a_game_nobody_connects_to_leaves_memory_after_the_grace_period(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;

        let id = waiting_game(&rooms, creator).await;

        eventually("the idle game is unloaded", || !rooms.is_open(id)).await;
    }

    #[sqlx::test]
    async fn a_game_stays_in_memory_while_someone_is_connected(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;

        let connection = rooms.connect(id, first).await.unwrap();
        tokio::time::sleep(GRACE * 6).await;
        assert!(rooms.is_open(id), "unloaded while connected");

        drop(connection);
        eventually("the game is unloaded once the player leaves", || {
            !rooms.is_open(id)
        })
        .await;
    }

    #[sqlx::test]
    async fn a_game_that_is_not_in_memory_is_loaded_when_a_player_connects(pool: PgPool) {
        let (first, second) = (user(&pool).await, user(&pool).await);
        let before = rooms(&pool, tally());
        let id = started_game(&before, first, second).await;
        let connection = before.connect(id, first).await.unwrap();
        connection.act(add(5)).await.unwrap();
        drop(connection);

        // A new set of rooms is as empty as after a restart.
        let after = rooms(&pool, tally());
        assert!(!after.is_open(id));
        let mut connection = after.connect(id, second).await.unwrap();

        assert!(after.is_open(id));
        let snapshot = connection.latest();
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.players, [first, second]);
        assert_eq!(snapshot.state, Some(json!({ "total": 5, "turn": 1 })));
    }

    #[sqlx::test]
    async fn only_players_of_a_known_game_can_connect(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second, outsider) = (user(&pool).await, user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let missing = Uuid::from_u128(1);

        assert_eq!(
            rooms.connect(id, outsider).await.err(),
            Some(RoomError::NotAPlayer)
        );
        assert_eq!(
            rooms.connect(missing, first).await.err(),
            Some(RoomError::NotFound)
        );
        eventually("a room for a missing game is not kept", || {
            !rooms.is_open(missing)
        })
        .await;
    }

    #[sqlx::test]
    async fn the_first_snapshot_describes_the_game_as_it_is(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;
        let id = waiting_game(&rooms, creator).await;

        let mut connection = rooms.connect(id, creator).await.unwrap();

        assert_eq!(
            *connection.latest(),
            Snapshot {
                game_id: id,
                kind: "tally",
                revision: 0,
                state_version: 1,
                players: vec![creator],
                state: None,
            }
        );
    }

    #[sqlx::test]
    async fn an_action_is_saved_and_then_published_to_everyone_connected(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let mut ada = rooms.connect(id, first).await.unwrap();
        let mut grace = rooms.connect(id, second).await.unwrap();

        ada.act(add(5)).await.unwrap();

        let expected = Some(json!({ "total": 5, "turn": 1 }));
        for connection in [&mut ada, &mut grace] {
            let snapshot = next(connection).await;
            assert_eq!(snapshot.revision, 2);
            assert_eq!(snapshot.state, expected);
        }
        assert_eq!(stored(&pool, id).await, (2, 1, expected));
    }

    #[sqlx::test]
    async fn every_action_is_a_new_revision(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let ada = rooms.connect(id, first).await.unwrap();
        let grace = rooms.connect(id, second).await.unwrap();

        ada.act(add(1)).await.unwrap();
        grace.act(add(2)).await.unwrap();
        ada.act(add(3)).await.unwrap();

        assert_eq!(
            stored(&pool, id).await,
            (4, 1, Some(json!({ "total": 6, "turn": 1 })))
        );
    }

    #[sqlx::test]
    async fn a_rejected_action_changes_nothing_and_publishes_nothing(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let mut ada = rooms.connect(id, first).await.unwrap();
        let grace = rooms.connect(id, second).await.unwrap();

        // It is Ada's turn.
        let refused = grace.act(add(1)).await;

        assert_eq!(
            refused,
            Err(RoomError::Rejected("not your turn".to_owned()))
        );
        assert_quiet(&mut ada).await;
        assert_eq!(
            stored(&pool, id).await,
            (1, 1, Some(json!({ "total": 0, "turn": 0 })))
        );
    }

    #[sqlx::test]
    async fn an_action_before_the_game_starts_is_refused(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;
        let id = waiting_game(&rooms, creator).await;
        let connection = rooms.connect(id, creator).await.unwrap();

        assert_eq!(connection.act(add(1)).await, Err(RoomError::NotStarted));
    }

    #[sqlx::test]
    async fn a_player_joining_is_published_to_those_connected(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = waiting_game(&rooms, first).await;
        let mut connection = rooms.connect(id, first).await.unwrap();

        rooms.join(id, second).await.unwrap();

        let snapshot = next(&mut connection).await;
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.players, [first, second]);
        assert_eq!(snapshot.state, Some(json!({ "total": 0, "turn": 0 })));
    }

    #[sqlx::test]
    async fn joining_at_the_same_time_gives_the_last_seat_to_one_player_only(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second, third) = (user(&pool).await, user(&pool).await, user(&pool).await);
        let id = waiting_game(&rooms, first).await;

        let (a, b) = tokio::join!(rooms.join(id, second), rooms.join(id, third));

        let mut results = [a, b];
        results.sort_by_key(|result| result.is_err());
        assert_eq!(results, [Ok(1), Err(RoomError::Full)]);
    }

    #[sqlx::test]
    async fn an_old_state_is_upgraded_on_load_and_saved_in_the_new_layout(pool: PgPool) {
        let (first, second) = (user(&pool).await, user(&pool).await);
        let old = rooms(&pool, Games::default().with::<Tally>());
        let id = started_game(&old, first, second).await;
        let connection = old.connect(id, first).await.unwrap();
        connection.act(add(1)).await.unwrap();
        drop(connection);
        eventually("the old server lets go of the game", || !old.is_open(id)).await;

        let new = rooms(&pool, Games::default().with::<TallyV2>());
        let mut connection = new.connect(id, second).await.unwrap();

        // Clients get the current layout...
        let snapshot = connection.latest();
        assert_eq!(snapshot.state_version, 2);
        assert_eq!(snapshot.state, Some(json!({ "sum": 1, "turn": 1 })));
        // ...while the row stays as it was until the game changes.
        assert_eq!(
            stored(&pool, id).await,
            (2, 1, Some(json!({ "total": 1, "turn": 1 })))
        );
        connection.act(add(2)).await.unwrap();
        assert_eq!(
            stored(&pool, id).await,
            (3, 2, Some(json!({ "sum": 3, "turn": 0 })))
        );
    }

    #[sqlx::test]
    async fn a_game_whose_save_fails_is_dropped_from_memory_and_reloaded_as_stored(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let mut ada = rooms.connect(id, first).await.unwrap();
        // Somebody else changes the game behind the room's back.
        sqlx::query("UPDATE games SET revision = revision + 1 WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();

        let result = ada.act(add(5)).await;

        assert_eq!(result, Err(RoomError::Internal));
        // Connections find out, and the lost action never reached anyone.
        assert!(ada.changed().await.is_none());
        eventually("the room shuts down", || !rooms.is_open(id)).await;
        let mut again = rooms.connect(id, first).await.unwrap();
        let snapshot = again.latest();
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.state, Some(json!({ "total": 0, "turn": 0 })));
    }

    #[sqlx::test]
    async fn a_game_of_a_kind_the_server_does_not_offer_cannot_be_opened(pool: PgPool) {
        let creator = user(&pool).await;
        let before = rooms(&pool, tally());
        let id = waiting_game(&before, creator).await;

        let after = rooms(&pool, Games::default());

        assert_eq!(
            after.connect(id, creator).await.err(),
            Some(RoomError::Internal)
        );
    }

    #[sqlx::test]
    async fn a_stored_state_the_game_cannot_read_cannot_be_opened(pool: PgPool) {
        let (first, second) = (user(&pool).await, user(&pool).await);
        let before = rooms(&pool, tally());
        let id = started_game(&before, first, second).await;
        sqlx::query("UPDATE games SET state = '{\"total\": \"lots\"}' WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();

        let after = rooms(&pool, tally());

        assert_eq!(
            after.connect(id, first).await.err(),
            Some(RoomError::Internal)
        );
    }

    #[sqlx::test]
    async fn a_request_that_reaches_a_room_as_it_shuts_down_goes_to_a_fresh_one(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        eventually("the room is unloaded", || !rooms.is_open(id)).await;

        // A room on its way out: it turns the request away and closes.
        let (commands, mut inbox) = mpsc::unbounded_channel();
        rooms.shared.open().insert(id, commands);
        tokio::spawn(async move {
            let request = inbox.recv().await.unwrap();
            inbox.close();
            request.fail(RoomError::Gone);
        });

        let connection = rooms.connect(id, first).await;

        assert!(connection.is_ok(), "{:?}", connection.err());
    }
}
