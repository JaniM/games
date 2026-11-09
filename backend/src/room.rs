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
use tokio::{
    sync::{mpsc, oneshot, watch},
    time::Instant,
};
use uuid::Uuid;

use crate::{
    bot::BOT_USER,
    game::{Engine, Games, Live},
    game_id::GameId,
};

/// How long a room with nobody connected stays in memory.
pub const IDLE_GRACE: Duration = Duration::from_secs(30);

/// How long the bot waits before each action it plays. The front end takes 450 ms to roll
/// the dice (`ROLL_MS`) and 225 ms to move a checker, so the player sees one thing finish
/// before the next starts.
pub const BOT_PAUSE: Duration = Duration::from_millis(450);

/// How many random ids a new game tries before giving up. One is nearly always enough.
const ID_ATTEMPTS: usize = 3;

/// Asking a room that is shutting down gets `Gone`, and the next attempt starts a
/// fresh one. Two attempts only fail if a room shuts down twice in a row.
const ATTEMPTS: usize = 3;

/// Everything about a game that clients see. A room publishes a new one after every
/// change, so a client never needs more than the latest.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub game_id: GameId,
    pub kind: &'static str,
    /// Counts the changes since the game was created. Rises by one for each
    /// player who joins and each action played, so clients can tell which of two snapshots is newer.
    /// (A player renaming themselves is not a change to the game; see `player_names`.)
    pub revision: i64,
    /// The layout version of `state`. The server only sends the current one.
    pub state_version: u32,
    /// The players' user ids, by seat.
    pub players: Vec<Uuid>,
    /// The players' display names, by seat: null for a player who hasn't picked one. A name
    /// that a player changes is published at once, as a snapshot with the same `revision`
    /// as before (the game itself didn't change). So of two snapshots with the same
    /// revision, the later one is the newer.
    pub player_names: Vec<Option<String>>,
    /// Null until every seat is taken.
    pub state: Option<Value>,
}

/// Why a request to a room failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomError {
    NotFound,
    /// The user has no seat in the game, so they can watch but not play.
    NotAPlayer,
    /// Every seat is taken.
    Full,
    /// A game against the bot was asked for, and the game has no bot.
    NoBot,
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
    /// How long the bot waits before each action it plays.
    bot_pause: Duration,
    /// How to reach each room. An entry whose channel is closed is a room that has shut
    /// down, and counts as absent. Rooms remove their own entry on the way out.
    open: Mutex<HashMap<GameId, mpsc::UnboundedSender<Command>>>,
}

impl Rooms {
    pub fn new(pool: PgPool, games: Games) -> Self {
        Self::with_timing(pool, games, IDLE_GRACE, BOT_PAUSE)
    }

    pub fn with_timing(
        pool: PgPool,
        games: Games,
        idle_grace: Duration,
        bot_pause: Duration,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                pool,
                games,
                idle_grace,
                bot_pause,
                open: Mutex::default(),
            }),
        }
    }

    pub fn games(&self) -> &Games {
        &self.shared.games
    }

    /// Creates a game of the given kind with `creator` in seat 0, and loads it.
    pub async fn create(
        &self,
        engine: &Arc<dyn Engine>,
        creator: Uuid,
    ) -> Result<GameId, RoomError> {
        // A game for one player has no one to wait for.
        let (state, finished) = match engine.players() {
            1 => {
                let live = engine.start();
                (to_json(Some(live.as_ref()))?, live.is_over())
            }
            _ => (None, false),
        };
        self.create_with(engine, &[creator], state, finished).await
    }

    /// Creates a game against the bot, which takes seat 1. The game starts at once, because
    /// there is no one else to wait for. [`RoomError::NoBot`] if the game has no bot.
    pub async fn create_against_bot(
        &self,
        engine: &Arc<dyn Engine>,
        creator: Uuid,
    ) -> Result<GameId, RoomError> {
        if !engine.has_bot() {
            return Err(RoomError::NoBot);
        }
        let live = engine.start();
        let state = to_json(Some(live.as_ref()))?;
        self.create_with(engine, &[creator, BOT_USER], state, live.is_over())
            .await
    }

    async fn create_with(
        &self,
        engine: &Arc<dyn Engine>,
        players: &[Uuid],
        state: Option<Value>,
        finished: bool,
    ) -> Result<GameId, RoomError> {
        let id = self
            .insert(engine.as_ref(), players, state, finished)
            .await
            .map_err(|err| internal(err, "could not create a game"))?;
        // Loading it now is what makes it a room, ready for the socket that follows.
        self.shared.room(&id);
        Ok(id)
    }

    /// Stores a new game with its players, who take seats in the order given.
    async fn insert(
        &self,
        engine: &dyn Engine,
        players: &[Uuid],
        state: Option<Value>,
        finished: bool,
    ) -> Result<GameId, String> {
        let db = |err: sqlx::Error| err.to_string();
        let mut tx = self.shared.pool.begin().await.map_err(db)?;
        // A random id is taken by another game once in a very long while. Then try another.
        let mut id = None;
        for _ in 0..ID_ATTEMPTS {
            let candidate = GameId::random().map_err(|err| err.to_string())?;
            let inserted: Option<GameId> = sqlx::query_scalar(
                "INSERT INTO games (id, kind, state_version, state, finished)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (id) DO NOTHING
                 RETURNING id",
            )
            .bind(&candidate)
            .bind(engine.kind())
            .bind(engine.state_version() as i32)
            .bind(&state)
            .bind(finished)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
            if inserted.is_some() {
                id = Some(candidate);
                break;
            }
        }
        let id = id.ok_or("every id tried was taken")?;
        for (seat, player) in players.iter().enumerate() {
            sqlx::query("INSERT INTO game_players (game_id, seat, user_id) VALUES ($1, $2, $3)")
                .bind(&id)
                .bind(seat as i16)
                .bind(player)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(id)
    }

    /// Tells every room in memory that `user` changed their display name, so that the games
    /// they play show it at once. Call it after the new name is saved: rooms read it from the
    /// database. Rooms that aren't in memory read it when they load. Doesn't wait for the rooms.
    pub fn name_changed(&self, user: Uuid) {
        // Every room hears it and the ones without `user` ignore it. It is rare enough that
        // finding the user's games first would cost more than it saves.
        for commands in self.shared.open().values() {
            _ = commands.send(Command::NameChanged { user });
        }
    }

    /// Seats `user` in the game and returns the seat. A user who already has a seat gets
    /// the same one again. Taking the last seat starts the game.
    pub async fn join(&self, game_id: &GameId, user: Uuid) -> Result<usize, RoomError> {
        let (seat, _) = self
            .request(game_id, |reply| Command::Join { user, reply })
            .await?;
        Ok(seat)
    }

    /// Connects `user` to the game's room. The room stays in memory until the connection
    /// is dropped.
    ///
    /// Anyone who knows the game can connect: a user without a seat watches. The seat is
    /// looked up when the connection acts, so a watcher who [`join`](Rooms::join)s the
    /// game can play on the connection they already have.
    pub async fn connect(&self, game_id: &GameId, user: Uuid) -> Result<Connection, RoomError> {
        let (snapshots, commands) = self
            .request(game_id, |reply| Command::Connect { reply })
            .await?;
        Ok(Connection {
            user,
            snapshots,
            commands,
        })
    }

    /// Whether the game is in memory.
    #[cfg(test)]
    pub fn is_open(&self, game_id: &GameId) -> bool {
        let open = self.shared.open();
        open.get(game_id)
            .is_some_and(|commands| !commands.is_closed())
    }

    /// Sends a command to the game's room, loading the room if needed, and returns the
    /// answer with the way to reach the room again.
    async fn request<T>(
        &self,
        game_id: &GameId,
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
    fn open(&self) -> MutexGuard<'_, HashMap<GameId, mpsc::UnboundedSender<Command>>> {
        // Nothing under this lock can panic halfway, so a poisoned lock holds valid data.
        self.open.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The way to reach the game's room, starting the room (which loads the game) if it
    /// isn't there. Returns before the game is loaded; requests wait in line.
    fn room(self: &Arc<Self>, id: &GameId) -> mpsc::UnboundedSender<Command> {
        let mut open = self.open();
        if let Some(commands) = open.get(id)
            && !commands.is_closed()
        {
            return commands.clone();
        }
        let (commands, inbox) = mpsc::unbounded_channel();
        open.insert(id.clone(), commands.clone());
        tokio::spawn(run(self.clone(), id.clone(), inbox));
        commands
    }

    /// Drops the entry of a room that has shut down. A newer room under the same id stays.
    fn forget(&self, id: &GameId) {
        let mut open = self.open();
        if open.get(id).is_some_and(|commands| commands.is_closed()) {
            open.remove(id);
        }
    }
}

/// The life of a room: load the game, serve requests, and on the way out turn away
/// whoever is still in line.
async fn run(shared: Arc<Shared>, id: GameId, mut inbox: mpsc::UnboundedReceiver<Command>) {
    let outcome = match Room::load(&shared, &id).await {
        Ok(mut room) => {
            tracing::debug!(game = %id, "game loaded");
            room.serve(&mut inbox, shared.idle_grace, shared.bot_pause)
                .await;
            tracing::debug!(game = %id, "game unloaded");
            RoomError::Gone
        }
        Err(err) => err,
    };
    // Closing first makes new requests start a fresh room instead of joining the queue
    // behind us. Whatever got in before that is answered here.
    inbox.close();
    shared.forget(&id);
    while let Ok(command) = inbox.try_recv() {
        command.fail(outcome.clone());
    }
}

enum Command {
    Connect {
        reply: oneshot::Sender<Result<watch::Receiver<Arc<Snapshot>>, RoomError>>,
    },
    Join {
        user: Uuid,
        reply: oneshot::Sender<Result<usize, RoomError>>,
    },
    Act {
        user: Uuid,
        action: Value,
        reply: oneshot::Sender<Result<(), RoomError>>,
    },
    /// A user changed their display name. Nobody waits for an answer.
    NameChanged { user: Uuid },
}

impl Command {
    /// Answers the command with an error. Nobody listening is fine.
    fn fail(self, err: RoomError) {
        match self {
            Self::Connect { reply, .. } => _ = reply.send(Err(err)),
            Self::Join { reply, .. } => _ = reply.send(Err(err)),
            Self::Act { reply, .. } => _ = reply.send(Err(err)),
            Self::NameChanged { .. } => {}
        }
    }
}

/// A user's link to a room: a player's, or a watcher's. Keeps the room in memory until dropped.
pub struct Connection {
    user: Uuid,
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

    /// Plays an action as this connection's user, who must have a seat in the game by now
    /// ([`RoomError::NotAPlayer`] otherwise). On success the new state has been saved and
    /// published, to this connection too.
    pub async fn act(&self, action: Value) -> Result<(), RoomError> {
        let (reply, answer) = oneshot::channel();
        let command = Command::Act {
            user: self.user,
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
    id: GameId,
    /// By seat.
    players: Vec<Uuid>,
    /// The players' display names, by seat. See [`Snapshot::player_names`].
    names: Vec<Option<String>>,
    /// The game, in its own type. It becomes JSON only to be stored and sent, and is never
    /// read back from JSON while the room is up. Null until every seat is taken.
    live: Option<Box<dyn Live>>,
    revision: i64,
    snapshots: watch::Sender<Arc<Snapshot>>,
    /// Set when a save failed: memory can't be trusted any more, so the room must stop.
    stale: bool,
}

impl Room {
    async fn load(shared: &Shared, id: &GameId) -> Result<Self, RoomError> {
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
        let names = read_names(&shared.pool, &players)
            .await
            .map_err(|err| internal(err, "could not load the names of a game's players"))?;

        let snapshot = Snapshot {
            game_id: id.clone(),
            kind: engine.kind(),
            revision,
            state_version: engine.state_version(),
            players: players.clone(),
            player_names: names.clone(),
            state,
        };
        Ok(Self {
            pool: shared.pool.clone(),
            engine: engine.clone(),
            id: id.clone(),
            players,
            names,
            live,
            revision,
            // Nobody is connected yet. The receiver the channel starts with is dropped at once.
            snapshots: watch::channel(Arc::new(snapshot)).0,
            stale: false,
        })
    }

    /// Handles requests until the room has been idle for `idle_grace` with nobody
    /// connected, or can no longer trust its state.
    ///
    /// When the bot has a move, it plays it `bot_pause` after the room last had something to
    /// show, but only while someone is connected: the bot plays for an audience. With nobody
    /// there it waits, the room goes idle like any other and leaves memory, and the bot
    /// carries on from the stored game when somebody next connects.
    async fn serve(
        &mut self,
        inbox: &mut mpsc::UnboundedReceiver<Command>,
        idle_grace: Duration,
        bot_pause: Duration,
    ) {
        /// What ended the wait.
        enum Wake {
            Command(Option<Command>),
            /// The last connection left. Look again to start the grace period.
            Unwatched,
            BotDue,
            Idle,
        }

        // When the bot plays next. Kept across loops, so that a request that doesn't change the
        // game (a name, another connection) doesn't push the bot's move back.
        let mut bot_due: Option<Instant> = None;
        loop {
            let watched = self.snapshots.receiver_count() > 0;
            if watched && self.bot_next().is_some() {
                bot_due.get_or_insert_with(|| Instant::now() + bot_pause);
            } else {
                bot_due = None;
            }

            // A condition keeps its branch from being polled, but not from being built.
            let wake = tokio::select! {
                command = inbox.recv() => Wake::Command(command),
                _ = self.snapshots.closed(), if watched => Wake::Unwatched,
                _ = tokio::time::sleep_until(bot_due.unwrap_or_else(Instant::now)), if bot_due.is_some() => Wake::BotDue,
                _ = tokio::time::sleep(idle_grace), if !watched => Wake::Idle,
            };
            match wake {
                Wake::Command(Some(command)) => self.handle(command).await,
                Wake::Command(None) | Wake::Idle => return,
                Wake::Unwatched => {}
                Wake::BotDue => {
                    bot_due = None; // The next move gets a pause of its own.
                    self.play_bot().await;
                }
            }
            if self.stale {
                return;
            }
        }
    }

    /// The game after the bot plays, if it is in the game and has a move.
    fn bot_next(&self) -> Option<Box<dyn Live>> {
        let seat = self.seat_of(BOT_USER)?;
        self.live.as_ref()?.bot_move(seat)
    }

    /// Plays the bot's move. A failure is logged and, if it was the save, stops the room.
    async fn play_bot(&mut self) {
        if let Some(next) = self.bot_next() {
            _ = self.commit(next).await;
        }
    }

    async fn handle(&mut self, command: Command) {
        match command {
            Command::Connect { reply } => _ = reply.send(self.connect()),
            Command::Join { user, reply } => _ = reply.send(self.join(user).await),
            Command::Act {
                user,
                action,
                reply,
            } => _ = reply.send(self.act(user, action).await),
            Command::NameChanged { user } => self.name_changed(user).await,
        }
    }

    fn connect(&self) -> Result<watch::Receiver<Arc<Snapshot>>, RoomError> {
        Ok(self.snapshots.subscribe())
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
        let finished = live.as_deref().is_some_and(|live| live.is_over());

        self.save(Some((seat, user)), state.as_ref(), finished)
            .await?;
        self.players.push(user);
        self.live = live;
        self.revision += 1;
        self.refresh_names().await;
        self.publish(state);
        Ok(seat)
    }

    async fn act(&mut self, user: Uuid, action: Value) -> Result<(), RoomError> {
        let seat = self.seat_of(user).ok_or(RoomError::NotAPlayer)?;
        let Some(live) = &self.live else {
            return Err(RoomError::NotStarted);
        };
        let next = live
            .apply(seat, action)
            .map_err(|rejection| RoomError::Rejected(rejection.reason().to_owned()))?;
        self.commit(next).await
    }

    /// Makes `next`, the game after an action, the game: saves it, and then tells everyone.
    async fn commit(&mut self, next: Box<dyn Live>) -> Result<(), RoomError> {
        let state = to_json(Some(next.as_ref()))?;

        self.save(None, state.as_ref(), next.is_over()).await?;
        self.live = Some(next);
        self.revision += 1;
        self.refresh_names().await;
        self.publish(state);
        Ok(())
    }

    /// Publishes the game again if `user`, a player here, has a different name than the room
    /// shows. The revision stays: nothing about the game changed, only how it is labelled.
    async fn name_changed(&mut self, user: Uuid) {
        if self.seat_of(user).is_none() {
            return; // Watchers' names aren't shown.
        }
        let before = self.names.clone();
        self.refresh_names().await;
        if self.names != before {
            // The state is what the last snapshot has. Read it first: `publish` replaces the snapshot.
            let state = self.snapshots.borrow().state.clone();
            self.publish(state);
        }
    }

    /// Reads the players' names again, to publish with a change. A name that can't be read
    /// is not worth failing a change that is already saved, so the old names stay.
    async fn refresh_names(&mut self) {
        match read_names(&self.pool, &self.players).await {
            Ok(names) => self.names = names,
            Err(err) => {
                tracing::warn!(%err, game = %self.id, "could not refresh the players' names")
            }
        }
    }

    fn seat_of(&self, user: Uuid) -> Option<usize> {
        self.players.iter().position(|player| *player == user)
    }

    /// Writes a change to the database as the next revision: the state, whether the game
    /// has ended with it, and the player who joined with it if there is one. The room is
    /// stale if this fails.
    async fn save(
        &mut self,
        new_player: Option<(usize, Uuid)>,
        state: Option<&Value>,
        finished: bool,
    ) -> Result<(), RoomError> {
        let change = Change {
            game_id: &self.id,
            from_revision: self.revision,
            state_version: self.engine.state_version() as i32,
            new_player,
            state,
            finished,
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
            game_id: self.id.clone(),
            kind: self.engine.kind(),
            revision: self.revision,
            state_version: self.engine.state_version(),
            players: self.players.clone(),
            player_names: self.names.clone(),
            state,
        }));
    }
}

/// The display names of `players`, in their order. Null for one who hasn't picked a name.
async fn read_names(pool: &PgPool, players: &[Uuid]) -> Result<Vec<Option<String>>, sqlx::Error> {
    let rows: Vec<(Uuid, Option<String>)> =
        sqlx::query_as("SELECT id, name FROM users WHERE id = ANY($1)")
            .bind(players)
            .fetch_all(pool)
            .await?;
    Ok(players
        .iter()
        .map(|player| {
            rows.iter()
                .find(|(id, _)| id == player)
                .and_then(|(_, name)| name.clone())
        })
        .collect())
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
    game_id: &'a GameId,
    /// The revision the change builds on.
    from_revision: i64,
    state_version: i32,
    new_player: Option<(usize, Uuid)>,
    state: Option<&'a Value>,
    /// The game has ended with this state.
    finished: bool,
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
         SET state = $2, state_version = $3, finished = $5,
             revision = revision + 1, updated_at = now()
         WHERE id = $1 AND revision = $4",
    )
    .bind(change.game_id)
    .bind(change.state)
    .bind(change.state_version)
    .bind(change.from_revision)
    .bind(change.finished)
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
    use crate::test_util::{Solo, TEST_BOT_PAUSE, Tally, TallyV2, TestApp, eventually};

    /// Short enough to wait out in a test.
    const GRACE: Duration = Duration::from_millis(50);

    fn tally() -> Games {
        Games::default().with::<Tally>().with::<Solo>()
    }

    fn rooms(pool: &PgPool, games: Games) -> Rooms {
        Rooms::with_timing(pool.clone(), games, GRACE, TEST_BOT_PAUSE)
    }

    async fn user(pool: &PgPool) -> Uuid {
        let app = TestApp::new(pool.clone(), Games::default());
        app.register_user().await.0.parse().unwrap()
    }

    /// A tally game with `first` in seat 0 and `second` in seat 1.
    async fn started_game(rooms: &Rooms, first: Uuid, second: Uuid) -> GameId {
        let id = waiting_game(rooms, first).await;
        rooms.join(&id, second).await.unwrap();
        id
    }

    async fn waiting_game(rooms: &Rooms, creator: Uuid) -> GameId {
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
    async fn stored(pool: &PgPool, id: &GameId) -> (i64, i32, Option<Value>) {
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

        assert!(rooms.is_open(&id));
    }

    #[sqlx::test]
    async fn a_game_nobody_connects_to_leaves_memory_after_the_grace_period(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;

        let id = waiting_game(&rooms, creator).await;

        eventually("the idle game is unloaded", || !rooms.is_open(&id)).await;
    }

    #[sqlx::test]
    async fn a_game_stays_in_memory_while_someone_is_connected(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;

        let connection = rooms.connect(&id, first).await.unwrap();
        tokio::time::sleep(GRACE * 6).await;
        assert!(rooms.is_open(&id), "unloaded while connected");

        drop(connection);
        eventually("the game is unloaded once the player leaves", || {
            !rooms.is_open(&id)
        })
        .await;
    }

    #[sqlx::test]
    async fn a_game_that_is_not_in_memory_is_loaded_when_a_player_connects(pool: PgPool) {
        let (first, second) = (user(&pool).await, user(&pool).await);
        let before = rooms(&pool, tally());
        let id = started_game(&before, first, second).await;
        let connection = before.connect(&id, first).await.unwrap();
        connection.act(add(5)).await.unwrap();
        drop(connection);

        // A new set of rooms is as empty as after a restart.
        let after = rooms(&pool, tally());
        assert!(!after.is_open(&id));
        let mut connection = after.connect(&id, second).await.unwrap();

        assert!(after.is_open(&id));
        let snapshot = connection.latest();
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.players, [first, second]);
        assert_eq!(snapshot.state, Some(json!({ "total": 5, "turn": 1 })));
    }

    #[sqlx::test]
    async fn anyone_can_connect_to_a_known_game_but_only_players_can_act(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second, outsider) = (user(&pool).await, user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let missing: GameId = "nosuchgame22".parse().unwrap();

        let mut watcher = rooms.connect(&id, outsider).await.unwrap();
        assert_eq!(watcher.latest().players, [first, second]);
        assert_eq!(watcher.act(add(1)).await, Err(RoomError::NotAPlayer));
        assert_eq!(
            rooms.connect(&missing, first).await.err(),
            Some(RoomError::NotFound)
        );
        eventually("a room for a missing game is not kept", || {
            !rooms.is_open(&missing)
        })
        .await;
    }

    #[sqlx::test]
    async fn a_watcher_who_takes_the_free_seat_can_act_on_the_connection_they_have(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = waiting_game(&rooms, first).await;
        let mut first_connection = rooms.connect(&id, first).await.unwrap();
        let mut watcher = rooms.connect(&id, second).await.unwrap();
        assert_eq!(watcher.act(add(1)).await, Err(RoomError::NotAPlayer));

        assert_eq!(rooms.join(&id, second).await, Ok(1));

        assert_eq!(next(&mut watcher).await.players, [first, second]);
        first_connection.act(add(2)).await.unwrap();
        // Snapshots keep only the newest, so look at this one before the next move.
        assert_eq!(
            next(&mut watcher).await.state,
            Some(json!({ "total": 2, "turn": 1 }))
        );
        watcher.act(add(3)).await.unwrap();
        assert_eq!(
            next(&mut first_connection).await.state,
            Some(json!({ "total": 5, "turn": 0 }))
        );
    }

    #[sqlx::test]
    async fn the_first_snapshot_describes_the_game_as_it_is(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;
        let id = waiting_game(&rooms, creator).await;

        let mut connection = rooms.connect(&id, creator).await.unwrap();

        assert_eq!(
            *connection.latest(),
            Snapshot {
                game_id: id.clone(),
                kind: "tally",
                revision: 0,
                state_version: 1,
                players: vec![creator],
                player_names: vec![None],
                state: None,
            }
        );
    }

    /// Whether the database says a game has finished.
    async fn finished(pool: &PgPool, id: &GameId) -> bool {
        sqlx::query_scalar("SELECT finished FROM games WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[sqlx::test]
    async fn a_game_is_saved_as_finished_when_its_rules_say_it_is_over(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let player = user(&pool).await;
        // Solo is over after its third action.
        let id = rooms
            .create(rooms.games().get("solo").unwrap(), player)
            .await
            .unwrap();
        let mut connection = rooms.connect(&id, player).await.unwrap();
        assert!(!finished(&pool, &id).await);

        for _ in 0..2 {
            connection.act(json!({})).await.unwrap();
            next(&mut connection).await;
        }
        assert!(!finished(&pool, &id).await);
        connection.act(json!({})).await.unwrap();
        next(&mut connection).await;

        assert!(finished(&pool, &id).await);
    }

    #[sqlx::test]
    async fn a_game_that_never_ends_is_never_saved_as_finished(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let mut ada = rooms.connect(&id, first).await.unwrap();

        ada.act(add(5)).await.unwrap();
        next(&mut ada).await;

        assert!(!finished(&pool, &id).await);
    }

    #[sqlx::test]
    async fn an_action_is_saved_and_then_published_to_everyone_connected(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let mut ada = rooms.connect(&id, first).await.unwrap();
        let mut grace = rooms.connect(&id, second).await.unwrap();

        ada.act(add(5)).await.unwrap();

        let expected = Some(json!({ "total": 5, "turn": 1 }));
        for connection in [&mut ada, &mut grace] {
            let snapshot = next(connection).await;
            assert_eq!(snapshot.revision, 2);
            assert_eq!(snapshot.state, expected);
        }
        assert_eq!(stored(&pool, &id).await, (2, 1, expected));
    }

    #[sqlx::test]
    async fn every_action_is_a_new_revision(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let ada = rooms.connect(&id, first).await.unwrap();
        let grace = rooms.connect(&id, second).await.unwrap();

        ada.act(add(1)).await.unwrap();
        grace.act(add(2)).await.unwrap();
        ada.act(add(3)).await.unwrap();

        assert_eq!(
            stored(&pool, &id).await,
            (4, 1, Some(json!({ "total": 6, "turn": 1 })))
        );
    }

    #[sqlx::test]
    async fn a_rejected_action_changes_nothing_and_publishes_nothing(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let mut ada = rooms.connect(&id, first).await.unwrap();
        let grace = rooms.connect(&id, second).await.unwrap();

        // It is Ada's turn.
        let refused = grace.act(add(1)).await;

        assert_eq!(
            refused,
            Err(RoomError::Rejected("not your turn".to_owned()))
        );
        assert_quiet(&mut ada).await;
        assert_eq!(
            stored(&pool, &id).await,
            (1, 1, Some(json!({ "total": 0, "turn": 0 })))
        );
    }

    #[sqlx::test]
    async fn an_action_before_the_game_starts_is_refused(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;
        let id = waiting_game(&rooms, creator).await;
        let connection = rooms.connect(&id, creator).await.unwrap();

        assert_eq!(connection.act(add(1)).await, Err(RoomError::NotStarted));
    }

    #[sqlx::test]
    async fn a_player_joining_is_published_to_those_connected(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = waiting_game(&rooms, first).await;
        let mut connection = rooms.connect(&id, first).await.unwrap();

        rooms.join(&id, second).await.unwrap();

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

        let (a, b) = tokio::join!(rooms.join(&id, second), rooms.join(&id, third));

        let mut results = [a, b];
        results.sort_by_key(|result| result.is_err());
        assert_eq!(results, [Ok(1), Err(RoomError::Full)]);
    }

    #[sqlx::test]
    async fn an_old_state_is_upgraded_on_load_and_saved_in_the_new_layout(pool: PgPool) {
        let (first, second) = (user(&pool).await, user(&pool).await);
        let old = rooms(&pool, Games::default().with::<Tally>());
        let id = started_game(&old, first, second).await;
        let connection = old.connect(&id, first).await.unwrap();
        connection.act(add(1)).await.unwrap();
        drop(connection);
        eventually("the old server lets go of the game", || !old.is_open(&id)).await;

        let new = rooms(&pool, Games::default().with::<TallyV2>());
        let mut connection = new.connect(&id, second).await.unwrap();

        // Clients get the current layout...
        let snapshot = connection.latest();
        assert_eq!(snapshot.state_version, 2);
        assert_eq!(snapshot.state, Some(json!({ "sum": 1, "turn": 1 })));
        // ...while the row stays as it was until the game changes.
        assert_eq!(
            stored(&pool, &id).await,
            (2, 1, Some(json!({ "total": 1, "turn": 1 })))
        );
        connection.act(add(2)).await.unwrap();
        assert_eq!(
            stored(&pool, &id).await,
            (3, 2, Some(json!({ "sum": 3, "turn": 0 })))
        );
    }

    #[sqlx::test]
    async fn a_game_whose_save_fails_is_dropped_from_memory_and_reloaded_as_stored(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let mut ada = rooms.connect(&id, first).await.unwrap();
        // Somebody else changes the game behind the room's back.
        sqlx::query("UPDATE games SET revision = revision + 1 WHERE id = $1")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();

        let result = ada.act(add(5)).await;

        assert_eq!(result, Err(RoomError::Internal));
        // Connections find out, and the lost action never reached anyone.
        assert!(ada.changed().await.is_none());
        eventually("the room shuts down", || !rooms.is_open(&id)).await;
        let mut again = rooms.connect(&id, first).await.unwrap();
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
            after.connect(&id, creator).await.err(),
            Some(RoomError::Internal)
        );
    }

    #[sqlx::test]
    async fn a_stored_state_the_game_cannot_read_cannot_be_opened(pool: PgPool) {
        let (first, second) = (user(&pool).await, user(&pool).await);
        let before = rooms(&pool, tally());
        let id = started_game(&before, first, second).await;
        sqlx::query("UPDATE games SET state = '{\"total\": \"lots\"}' WHERE id = $1")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();

        let after = rooms(&pool, tally());

        assert_eq!(
            after.connect(&id, first).await.err(),
            Some(RoomError::Internal)
        );
    }

    #[sqlx::test]
    async fn a_request_that_reaches_a_room_as_it_shuts_down_goes_to_a_fresh_one(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        eventually("the room is unloaded", || !rooms.is_open(&id)).await;

        // A room on its way out: it turns the request away and closes.
        let (commands, mut inbox) = mpsc::unbounded_channel();
        rooms.shared.open().insert(id.clone(), commands);
        tokio::spawn(async move {
            let request = inbox.recv().await.unwrap();
            inbox.close();
            request.fail(RoomError::Gone);
        });

        let connection = rooms.connect(&id, first).await;

        assert!(connection.is_ok(), "{:?}", connection.err());
    }

    // --- The bot ---

    /// A tally game for `creator` against the bot, which is in seat 1 and adds 1 on its turn.
    async fn bot_game(rooms: &Rooms, creator: Uuid) -> GameId {
        let engine = rooms.games().get("tally").unwrap().clone();
        rooms.create_against_bot(&engine, creator).await.unwrap()
    }

    #[sqlx::test]
    async fn a_game_against_the_bot_has_it_seated_and_has_begun(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;

        let id = bot_game(&rooms, creator).await;

        let mut connection = rooms.connect(&id, creator).await.unwrap();
        let snapshot = connection.latest();
        assert_eq!(snapshot.players, [creator, BOT_USER]);
        assert_eq!(snapshot.player_names, [None, Some("Bot".to_owned())]);
        assert_eq!(snapshot.state, Some(json!({ "total": 0, "turn": 0 })));
    }

    #[sqlx::test]
    async fn a_game_without_a_bot_cannot_be_played_against_one(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;
        let solo = rooms.games().get("solo").unwrap().clone();

        let result = rooms.create_against_bot(&solo, creator).await;

        assert_eq!(result, Err(RoomError::NoBot));
    }

    #[sqlx::test]
    async fn the_bot_answers_the_players_move(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;
        let id = bot_game(&rooms, creator).await;
        let mut connection = rooms.connect(&id, creator).await.unwrap();

        connection.act(add(5)).await.unwrap();

        // The player's move is published first, and then the bot's, as a change of its own.
        let after_player = next(&mut connection).await;
        assert_eq!(after_player.state, Some(json!({ "total": 5, "turn": 1 })));
        let after_bot = next(&mut connection).await;
        assert_eq!(after_bot.state, Some(json!({ "total": 6, "turn": 0 })));
        assert_eq!(after_bot.revision, after_player.revision + 1);
        // It was saved like any other change, and it is the player's turn again.
        assert_eq!(
            stored(&pool, &id).await,
            (2, 1, Some(json!({ "total": 6, "turn": 0 })))
        );
        assert_quiet(&mut connection).await;
    }

    #[sqlx::test]
    async fn the_bot_does_not_move_on_the_players_turn(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;
        let id = bot_game(&rooms, creator).await;
        let mut connection = rooms.connect(&id, creator).await.unwrap();

        // It is the player's turn from the start: the bot has to wait for it.
        assert_quiet(&mut connection).await;

        assert_eq!(stored(&pool, &id).await.0, 0);
    }

    #[sqlx::test]
    async fn the_bot_does_not_play_to_an_empty_room(pool: PgPool) {
        // The bot would play after 400 ms, and the room is gone after 50.
        let rooms = Rooms::with_timing(pool.clone(), tally(), GRACE, Duration::from_millis(400));
        let creator = user(&pool).await;
        let id = bot_game(&rooms, creator).await;
        let connection = rooms.connect(&id, creator).await.unwrap();
        connection.act(add(5)).await.unwrap();

        // The player leaves before the bot's turn comes.
        drop(connection);
        eventually("the room is unloaded", || !rooms.is_open(&id)).await;
        tokio::time::sleep(Duration::from_millis(500)).await;

        assert_eq!(
            stored(&pool, &id).await,
            (1, 1, Some(json!({ "total": 5, "turn": 1 })))
        );
    }

    #[sqlx::test]
    async fn the_bot_carries_on_from_the_stored_game_when_somebody_comes_back(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;
        let id = bot_game(&rooms, creator).await;
        eventually("the new room is unloaded", || !rooms.is_open(&id)).await;
        // The game as a server that stopped on the bot's turn would have left it.
        sqlx::query("UPDATE games SET state = '{\"total\": 7, \"turn\": 1}' WHERE id = $1")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();

        let mut connection = rooms.connect(&id, creator).await.unwrap();

        assert_eq!(
            connection.latest().state,
            Some(json!({ "total": 7, "turn": 1 }))
        );
        let after_bot = next(&mut connection).await;
        assert_eq!(after_bot.state, Some(json!({ "total": 8, "turn": 0 })));
    }

    #[sqlx::test]
    async fn the_bot_plays_for_a_spectator_too(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (creator, spectator) = (user(&pool).await, user(&pool).await);
        let id = bot_game(&rooms, creator).await;
        eventually("the new room is unloaded", || !rooms.is_open(&id)).await;
        sqlx::query("UPDATE games SET state = '{\"total\": 0, \"turn\": 1}' WHERE id = $1")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();

        // Somebody watching is an audience, even though they cannot play.
        let mut connection = rooms.connect(&id, spectator).await.unwrap();

        let after_bot = next(&mut connection).await;
        assert_eq!(after_bot.state, Some(json!({ "total": 1, "turn": 0 })));
    }

    #[sqlx::test]
    async fn only_the_bots_own_turn_is_played_for_it(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (creator, other) = (user(&pool).await, user(&pool).await);
        let id = bot_game(&rooms, creator).await;
        let mut connection = rooms.connect(&id, creator).await.unwrap();

        // A seat the bot does not have can't be used by anyone else.
        assert_eq!(
            rooms.join(&id, other).await,
            Err(RoomError::Full),
            "nobody takes the bot's seat"
        );
        assert_quiet(&mut connection).await;
    }
}
