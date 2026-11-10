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
//! A change that gives the game a state is also kept in the game's history, in the same
//! transaction (see `history`).
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
use sqlx::{PgConnection, PgPool};
use tokio::{
    sync::{broadcast, mpsc, oneshot, watch},
    task::{JoinError, JoinHandle},
    time::Instant,
};
use uuid::Uuid;

use crate::{
    bot::Level,
    game::{BotJob, Engine, Games, Live},
    game_id::GameId,
    history,
    rematch::{self, Outcome, Rematch},
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
    /// player who joins, each action played and each step of the rematch (see `rematch`), so
    /// clients can tell which of two snapshots is newer.
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
    /// Which players are guests, parallel to `players`: users who haven't made an account. A
    /// registered user's name is their username, which nobody else can have; a guest's name is
    /// whatever they typed, so clients show it with a guest indicator. The bot and a user who has
    /// deleted themselves are not guests. Published with `player_names`, and changes with them:
    /// a guest who makes an account is published at once.
    pub player_guests: Vec<bool>,
    /// Null until every seat is taken.
    pub state: Option<Value>,
    /// Null until a player of the finished game asks to play again.
    pub rematch: Option<Rematch>,
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
    /// A rematch was asked about a game that hasn't ended.
    NotOver,
    /// A rematch was asked about a game that isn't for two players, so has no other side, or
    /// whose other player has deleted their user.
    NoRematch,
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
    /// Says which user has just deleted themselves, so that their connections end (see
    /// [`Rooms::user_gone`]).
    gone: broadcast::Sender<Uuid>,
}

/// How many deleted users a connection may miss before it can't tell whether it was one of
/// them. Missing that many ends the connection, which only costs the client a reconnect.
const GONE_BACKLOG: usize = 64;

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
                gone: broadcast::channel(GONE_BACKLOG).0,
            }),
        }
    }

    pub fn games(&self) -> &Games {
        &self.shared.games
    }

    /// Creates a game of the given kind with `creator` in seat 0, and loads it. A `public` game
    /// is in the public list (see `lobby`) once it has started.
    pub async fn create(
        &self,
        engine: &Arc<dyn Engine>,
        creator: Uuid,
        public: bool,
    ) -> Result<GameId, RoomError> {
        // A game for one player has no one to wait for.
        let live = (engine.players() == 1).then(|| engine.start());
        let game = NewGame::new(engine.as_ref(), vec![creator], live.as_deref(), public)?;
        self.create_with(game).await
    }

    /// Creates a game against the bot of the given level, which takes seat 1. The game starts at
    /// once, because there is no one else to wait for. [`RoomError::NoBot`] if the game has no bot.
    pub async fn create_against_bot(
        &self,
        engine: &Arc<dyn Engine>,
        creator: Uuid,
        level: Level,
        public: bool,
    ) -> Result<GameId, RoomError> {
        if !engine.has_bot() {
            return Err(RoomError::NoBot);
        }
        let live = engine.start();
        let game = NewGame::new(
            engine.as_ref(),
            vec![creator, level.user()],
            Some(live.as_ref()),
            public,
        )?;
        self.create_with(game).await
    }

    async fn create_with(&self, game: NewGame) -> Result<GameId, RoomError> {
        let id = self
            .insert(&game)
            .await
            .map_err(|err| internal(err, "could not create a game"))?;
        // Loading it now is what makes it a room, ready for the socket that follows.
        self.shared.room(&id);
        Ok(id)
    }

    /// Stores a new game with its players.
    async fn insert(&self, game: &NewGame) -> Result<GameId, String> {
        let db = |err: sqlx::Error| err.to_string();
        let mut tx = self.shared.pool.begin().await.map_err(db)?;
        let id = insert_game(&mut tx, game).await?;
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

    /// Ends every connection `user` has, to any game: they have deleted themselves, and their
    /// token (which a socket only checked when it opened) no longer means anything. Their
    /// sockets close as a game going away does, and a client that reconnects is turned away
    /// as unauthorized. Doesn't wait.
    pub fn user_gone(&self, user: Uuid) {
        // Nobody listening is fine: nobody is connected.
        _ = self.shared.gone.send(user);
    }

    /// Stops the rooms in memory of games that have been deleted, so that nobody keeps
    /// watching what isn't there. Their connections end like those of any room that goes away.
    pub fn close(&self, games: &[GameId]) {
        let open = self.shared.open();
        for id in games {
            if let Some(commands) = open.get(id) {
                _ = commands.send(Command::Close);
            }
        }
    }

    /// Tells the game's room (loading it if need be) that `user`, a player of it, has deleted
    /// themselves: the game shows them as deleted, and a rematch that was waiting for them is
    /// dropped, because nobody is left to answer it. Call it after the user is deleted: the room
    /// reads that from the database.
    pub async fn user_deleted(&self, game_id: &GameId, user: Uuid) -> Result<(), RoomError> {
        self.request(game_id, |reply| Command::UserDeleted { user, reply })
            .await
            .map(|_| ())
    }

    /// Makes `user`, a player, give up the game, without a connection: for the server to
    /// forfeit for a user who is deleting their account. Errors as [`Connection::forfeit`] does.
    pub async fn forfeit(&self, game_id: &GameId, user: Uuid) -> Result<(), RoomError> {
        self.request(game_id, |reply| Command::Forfeit { user, reply })
            .await
            .map(|_| ())
    }

    /// `user`, a player of the finished game, asks to play it again, or says yes to the other
    /// player's ask (see [`rematch`](crate::rematch)). Returns where the rematch stands. When
    /// it is [`Rematch::Accepted`] the new game exists, with the same players, and is loaded.
    pub async fn ask_rematch(
        &self,
        game_id: &GameId,
        user: Uuid,
    ) -> Result<Option<Rematch>, RoomError> {
        let (rematch, _) = self
            .request(game_id, |reply| Command::AskRematch { user, reply })
            .await?;
        if let Some(Rematch::Accepted { game_id: next }) = &rematch {
            // As for a new game: loading it now makes it a room, ready for the sockets that follow.
            self.shared.room(next);
        }
        Ok(rematch)
    }

    /// `user` takes back their own ask for a rematch, or turns down the other player's.
    /// Returns where the rematch stands.
    pub async fn decline_rematch(
        &self,
        game_id: &GameId,
        user: Uuid,
    ) -> Result<Option<Rematch>, RoomError> {
        let (rematch, _) = self
            .request(game_id, |reply| Command::DeclineRematch { user, reply })
            .await?;
        Ok(rematch)
    }

    /// Connects `user` to the game's room. The room stays in memory until the connection
    /// is dropped.
    ///
    /// Anyone who knows the game can connect: a user without a seat watches. The seat is
    /// looked up when the connection acts, so a watcher who [`join`](Rooms::join)s the
    /// game can play on the connection they already have.
    pub async fn connect(&self, game_id: &GameId, user: Uuid) -> Result<Connection, RoomError> {
        // Before the request, so that a deletion that happens while it waits is not missed.
        let gone = self.shared.gone.subscribe();
        let (snapshots, commands) = self
            .request(game_id, |reply| Command::Connect { reply })
            .await?;
        Ok(Connection {
            user,
            snapshots,
            commands,
            gone,
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
    /// A player gives up the game.
    Forfeit {
        user: Uuid,
        reply: oneshot::Sender<Result<(), RoomError>>,
    },
    /// A player asks for a rematch, or answers yes. The reply is where the rematch stands.
    AskRematch {
        user: Uuid,
        reply: oneshot::Sender<Result<Option<Rematch>, RoomError>>,
    },
    /// A player takes back their ask for a rematch, or answers no.
    DeclineRematch {
        user: Uuid,
        reply: oneshot::Sender<Result<Option<Rematch>, RoomError>>,
    },
    /// A user changed their display name. Nobody waits for an answer.
    NameChanged { user: Uuid },
    /// A player deleted their user. See [`Rooms::user_deleted`].
    UserDeleted {
        user: Uuid,
        reply: oneshot::Sender<Result<(), RoomError>>,
    },
    /// The game was deleted: stop. Nobody waits for an answer.
    Close,
}

impl Command {
    /// Answers the command with an error. Nobody listening is fine.
    fn fail(self, err: RoomError) {
        match self {
            Self::Connect { reply, .. } => _ = reply.send(Err(err)),
            Self::Join { reply, .. } => _ = reply.send(Err(err)),
            Self::Act { reply, .. } => _ = reply.send(Err(err)),
            Self::Forfeit { reply, .. } => _ = reply.send(Err(err)),
            Self::AskRematch { reply, .. } => _ = reply.send(Err(err)),
            Self::DeclineRematch { reply, .. } => _ = reply.send(Err(err)),
            Self::NameChanged { .. } | Self::Close => {}
            Self::UserDeleted { reply, .. } => _ = reply.send(Err(err)),
        }
    }
}

/// A user's link to a room: a player's, or a watcher's. Keeps the room in memory until dropped.
pub struct Connection {
    user: Uuid,
    snapshots: watch::Receiver<Arc<Snapshot>>,
    commands: mpsc::UnboundedSender<Command>,
    /// The users who delete themselves while this connection is open.
    gone: broadcast::Receiver<Uuid>,
}

impl Connection {
    /// The newest snapshot. [`Connection::changed`] waits for ones newer than this.
    pub fn latest(&mut self) -> Arc<Snapshot> {
        self.snapshots.borrow_and_update().clone()
    }

    /// Waits for a snapshot newer than the last one seen and returns the newest. Only the
    /// latest matters, so a slow reader skips the ones in between. Returns `None` when the
    /// room has shut down, or this connection's user has deleted themselves (see
    /// [`Rooms::user_gone`]); connect again to get a fresh one.
    pub async fn changed(&mut self) -> Option<Arc<Snapshot>> {
        loop {
            tokio::select! {
                changed = self.snapshots.changed() => {
                    changed.ok()?;
                    return Some(self.latest());
                }
                gone = self.gone.recv() => match gone {
                    Ok(user) if user != self.user => {}
                    // This user, or too many to tell whether it was: end the connection.
                    // Reconnecting is all that costs a user who is still here.
                    _ => return None,
                },
            }
        }
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

    /// Gives up the game as this connection's user, who must have a seat in it. Errors as
    /// [`Connection::act`] does; a game that is over refuses with [`RoomError::Rejected`].
    pub async fn forfeit(&self) -> Result<(), RoomError> {
        let (reply, answer) = oneshot::channel();
        let command = Command::Forfeit {
            user: self.user,
            reply,
        };
        self.commands.send(command).map_err(|_| RoomError::Gone)?;
        answer.await.map_err(|_| RoomError::Internal)?
    }
}

/// A job that is working out the bot's move, and the revision of the game it works on.
type Thinking = (JoinHandle<Option<Box<dyn Live>>>, i64);

/// The state behind a room, owned by its task.
struct Room {
    pool: PgPool,
    engine: Arc<dyn Engine>,
    id: GameId,
    /// By seat.
    players: Vec<Uuid>,
    /// Who the players are, by seat, as clients are told.
    who: Who,
    /// The game, in its own type. It becomes JSON only to be stored and sent, and is never
    /// read back from JSON while the room is up. Null until every seat is taken.
    live: Option<Box<dyn Live>>,
    revision: i64,
    /// Whether the game is in the public list. Its rematch is too.
    public: bool,
    /// Whether the players have agreed to play again. Only a finished game has one.
    rematch: Option<Rematch>,
    snapshots: watch::Sender<Arc<Snapshot>>,
    /// The record of the latest row this room wrote to the game's history, which is what a
    /// delta in the next row builds on (see `history`). Null for a room that hasn't written one,
    /// even if the game has rows from before: it can't tell what an older server wrote, so its
    /// first row is a whole state.
    last_record: Option<Value>,
    /// Set when a save failed: memory can't be trusted any more, so the room must stop.
    stale: bool,
}

/// One row of the query that loads a game, in the order of its columns: kind, state version,
/// state, revision, rematch and whether it is public.
type StoredGame = (String, i32, Option<Value>, i64, Option<Value>, bool);

impl Room {
    async fn load(shared: &Shared, id: &GameId) -> Result<Self, RoomError> {
        let row: Option<StoredGame> = sqlx::query_as(
            "SELECT kind, state_version, state, revision, rematch, public FROM games WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&shared.pool)
        .await
        .map_err(|err| internal(err, "could not load a game"))?;
        let (kind, state_version, state, revision, rematch, public) =
            row.ok_or(RoomError::NotFound)?;
        let rematch: Option<Rematch> = rematch
            .map(serde_json::from_value)
            .transpose()
            .map_err(|err| internal(err, "could not read a stored rematch"))?;
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
        let who = read_players(&shared.pool, &players)
            .await
            .map_err(|err| internal(err, "could not load the names of a game's players"))?;

        let snapshot = Snapshot {
            game_id: id.clone(),
            kind: engine.kind(),
            revision,
            state_version: engine.state_version(),
            players: players.clone(),
            player_names: who.names.clone(),
            player_guests: who.guests.clone(),
            state,
            rematch: rematch.clone(),
        };
        Ok(Self {
            pool: shared.pool.clone(),
            engine: engine.clone(),
            id: id.clone(),
            players,
            who,
            live,
            revision,
            public,
            rematch,
            // Nobody is connected yet. The receiver the channel starts with is dropped at once.
            snapshots: watch::channel(Arc::new(snapshot)).0,
            last_record: None,
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
    ///
    /// Working out the move can take a while, so it is done by a blocking job on a thread of its
    /// own, while the room goes on serving requests. A move is made only if the game is still as
    /// it was when the job began, and somebody is still there to see it: a player who gives up
    /// while the bot is thinking has ended a game that the bot's move is no part of.
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
            /// The job that works out the bot's move has finished.
            BotDone(Result<Option<Box<dyn Live>>, JoinError>),
            Idle,
        }

        // When the bot plays next. Kept across loops, so that a request that doesn't change the
        // game (a name, another connection) doesn't push the bot's move back.
        let mut bot_due: Option<Instant> = None;
        // The job that is working out the bot's move, and the revision of the game it works on.
        let mut thinking: Option<Thinking> = None;
        // The revision at which the bot had no move though it was its turn, which is a bug in the
        // bot. It isn't asked again until the game has changed, or it would be asked forever.
        let mut stuck_at: Option<i64> = None;
        loop {
            // A job for a game that has moved on has nothing to say. Its thread finishes by itself.
            if thinking
                .as_ref()
                .is_some_and(|&(_, revision)| revision != self.revision)
            {
                thinking = None;
            }
            let watched = self.snapshots.receiver_count() > 0;
            if watched && thinking.is_none() && stuck_at != Some(self.revision) && self.bot_turn() {
                bot_due.get_or_insert_with(|| Instant::now() + bot_pause);
            } else {
                bot_due = None;
            }

            // A condition keeps its branch from being polled, but not from being built.
            let wake = tokio::select! {
                command = inbox.recv() => Wake::Command(command),
                _ = self.snapshots.closed(), if watched => Wake::Unwatched,
                _ = tokio::time::sleep_until(bot_due.unwrap_or_else(Instant::now)), if bot_due.is_some() => Wake::BotDue,
                done = async {
                    match thinking.as_mut() {
                        Some((job, _)) => job.await,
                        None => std::future::pending().await,
                    }
                }, if thinking.is_some() => Wake::BotDone(done),
                _ = tokio::time::sleep(idle_grace), if !watched => Wake::Idle,
            };
            match wake {
                Wake::Command(Some(command)) => self.handle(command).await,
                Wake::Command(None) | Wake::Idle => return,
                Wake::Unwatched => {}
                Wake::BotDue => {
                    bot_due = None; // The next move gets a pause of its own.
                    if let Some(job) = self.bot_job() {
                        thinking = Some((tokio::task::spawn_blocking(job), self.revision));
                    }
                }
                Wake::BotDone(done) => {
                    let (_, revision) = thinking.take().expect("a job was running");
                    match done {
                        // A failure to save is logged and stops the room.
                        Ok(Some(next))
                            if revision == self.revision && self.snapshots.receiver_count() > 0 =>
                        {
                            _ = self.commit(next).await;
                        }
                        Ok(Some(_)) => {}
                        Ok(None) => stuck_at = Some(revision),
                        Err(err) => {
                            tracing::error!(game = %self.id, %err, "the bot's move could not be worked out");
                            stuck_at = Some(revision);
                        }
                    }
                }
            }
            if self.stale {
                return;
            }
        }
    }

    /// The seat the bot has in this game and its level, if it is one of the players.
    fn bot(&self) -> Option<(usize, Level)> {
        self.players
            .iter()
            .enumerate()
            .find_map(|(seat, &player)| Some((seat, Level::of(player)?)))
    }

    /// Whether the bot has a move to play. Cheap, which working out the move is not.
    fn bot_turn(&self) -> bool {
        match (self.bot(), self.live.as_ref()) {
            (Some((seat, _)), Some(live)) => live.bot_turn(seat),
            _ => false,
        }
    }

    /// The job that works out the bot's move, if it has one, at the level of the bot that has
    /// the seat.
    fn bot_job(&self) -> Option<BotJob> {
        let (seat, level) = self.bot()?;
        let live = self.live.as_ref()?;
        live.bot_turn(seat).then(|| live.bot_job(seat, level))
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
            Command::Forfeit { user, reply } => _ = reply.send(self.forfeit(user).await),
            Command::AskRematch { user, reply } => _ = reply.send(self.ask_rematch(user).await),
            Command::DeclineRematch { user, reply } => {
                _ = reply.send(self.decline_rematch(user).await)
            }
            Command::NameChanged { user } => self.name_changed(user).await,
            Command::UserDeleted { user, reply } => _ = reply.send(self.user_deleted(user).await),
            // The room can't trust what it has any more, as after a failed save: it stops.
            Command::Close => self.stale = true,
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
        let record = to_record(live.as_deref())?;
        let finished = live.as_deref().is_some_and(|live| live.is_over());

        self.save(Some((seat, user)), state.as_ref(), record, finished)
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

    /// `user`, a player, gives up the game. Allowed on any turn, once the game has started and
    /// until it is over (the game refuses it then).
    async fn forfeit(&mut self, user: Uuid) -> Result<(), RoomError> {
        let seat = self.seat_of(user).ok_or(RoomError::NotAPlayer)?;
        let Some(live) = &self.live else {
            return Err(RoomError::NotStarted);
        };
        let next = live
            .forfeit(seat)
            .map_err(|rejection| RoomError::Rejected(rejection.reason().to_owned()))?;
        self.commit(next).await
    }

    /// Makes `next`, the game after an action, the game: saves it, and then tells everyone.
    async fn commit(&mut self, next: Box<dyn Live>) -> Result<(), RoomError> {
        let state = to_json(Some(next.as_ref()))?;
        let record = to_record(Some(next.as_ref()))?;

        self.save(None, state.as_ref(), record, next.is_over())
            .await?;
        self.live = Some(next);
        self.revision += 1;
        self.refresh_names().await;
        self.publish(state);
        Ok(())
    }

    /// The seat of `user` if they may take part in a rematch of this game: they are a player,
    /// the game is for two players, and it is over.
    fn rematch_seat(&self, user: Uuid) -> Result<usize, RoomError> {
        let seat = self.seat_of(user).ok_or(RoomError::NotAPlayer)?;
        if self.engine.players() != 2 {
            return Err(RoomError::NoRematch);
        }
        match &self.live {
            Some(live) if live.is_over() => {}
            _ => return Err(RoomError::NotOver),
        }
        // Nobody to play it with.
        if (0..self.players.len()).any(|other| other != seat && self.who.deleted[other]) {
            return Err(RoomError::NoRematch);
        }
        Ok(seat)
    }

    async fn ask_rematch(&mut self, user: Uuid) -> Result<Option<Rematch>, RoomError> {
        let seat = self.rematch_seat(user)?;
        let opponent_is_bot = self
            .players
            .get(1 - seat)
            .is_some_and(|&player| Level::of(player).is_some());
        let outcome = rematch::ask(self.rematch.as_ref(), seat, opponent_is_bot);
        self.change_rematch(outcome).await?;
        Ok(self.rematch.clone())
    }

    async fn decline_rematch(&mut self, user: Uuid) -> Result<Option<Rematch>, RoomError> {
        let seat = self.rematch_seat(user)?;
        let outcome = rematch::decline(self.rematch.as_ref(), seat);
        self.change_rematch(outcome).await?;
        Ok(self.rematch.clone())
    }

    /// Carries out what a request did to the rematch: saves it as the next revision, and then
    /// tells everyone. The game itself is as it was.
    async fn change_rematch(&mut self, outcome: Outcome) -> Result<(), RoomError> {
        let (rematch, new_game) = match outcome {
            Outcome::Unchanged => return Ok(()),
            Outcome::Becomes(rematch) => (rematch, None),
            // The rematch is accepted by the game that is made for it.
            Outcome::Start => (None, Some(self.rematch_game()?)),
        };
        let change = RematchChange {
            game_id: &self.id,
            from_revision: self.revision,
            rematch: rematch.as_ref(),
            new_game,
        };
        let saved = write_rematch(&self.pool, change).await;
        self.rematch = saved.map_err(|reason| {
            self.stale = true;
            internal(
                reason,
                "could not save a rematch, so dropping it from memory",
            )
        })?;
        self.revision += 1;
        // The state is what the last snapshot has. Read it first: `publish` replaces the snapshot.
        let state = self.snapshots.borrow().state.clone();
        self.publish(state);
        Ok(())
    }

    /// The game that follows this one: new, for the same players in the same seats, and as
    /// public as this one.
    fn rematch_game(&self) -> Result<NewGame, RoomError> {
        let live = self.engine.start();
        NewGame::new(
            self.engine.as_ref(),
            self.players.clone(),
            Some(live.as_ref()),
            self.public,
        )
    }

    /// Publishes the game again if `user`, a player here, is labelled differently than the room
    /// shows: a new name, or a guest who has made an account. The revision stays: nothing about
    /// the game changed, only how it is labelled.
    async fn name_changed(&mut self, user: Uuid) {
        if self.seat_of(user).is_none() {
            return; // Watchers' names aren't shown.
        }
        let before = self.who.clone();
        self.refresh_names().await;
        if self.who != before {
            // The state is what the last snapshot has. Read it first: `publish` replaces the snapshot.
            let state = self.snapshots.borrow().state.clone();
            self.publish(state);
        }
    }

    /// Reads the players' names (and whether they have deleted their user) again, to publish
    /// with a change. A name that can't be read is not worth failing a change that is already
    /// saved, so the old names stay.
    async fn refresh_names(&mut self) {
        match read_players(&self.pool, &self.players).await {
            Ok(who) => self.who = who,
            Err(err) => {
                tracing::warn!(%err, game = %self.id, "could not refresh the players' names")
            }
        }
    }

    /// `user`, a player here, has deleted their user. Shows them as deleted, and drops a
    /// rematch that is still undecided: nobody is left to answer it.
    async fn user_deleted(&mut self, user: Uuid) -> Result<(), RoomError> {
        if self.seat_of(user).is_none() {
            return Ok(());
        }
        let before = self.who.clone();
        self.refresh_names().await;
        if matches!(
            self.rematch,
            Some(Rematch::Offered { .. } | Rematch::Declined { .. })
        ) {
            // Saves it as the next revision and publishes, with the names read just now.
            return self.change_rematch(Outcome::Becomes(None)).await;
        }
        if self.who != before {
            // The state is what the last snapshot has. Read it first: `publish` replaces the snapshot.
            let state = self.snapshots.borrow().state.clone();
            self.publish(state);
        }
        Ok(())
    }

    fn seat_of(&self, user: Uuid) -> Option<usize> {
        self.players.iter().position(|player| *player == user)
    }

    /// Writes a change to the database as the next revision: the state (and its record for the
    /// game's history, see `history`), whether the game has ended with it, and the player who
    /// joined with it if there is one. The room is stale if this fails.
    async fn save(
        &mut self,
        new_player: Option<(usize, Uuid)>,
        state: Option<&Value>,
        record: Option<Value>,
        finished: bool,
    ) -> Result<(), RoomError> {
        let change = Change {
            game_id: &self.id,
            from_revision: self.revision,
            state_version: self.engine.state_version() as i32,
            new_player,
            state,
            previous: self.last_record.as_ref(),
            record: record.as_ref(),
            finished,
        };
        // Not a method: the future may only borrow what it needs, so that a game's
        // state doesn't have to be `Sync`.
        let saved = write(&self.pool, change).await;
        saved.map_err(|reason| {
            self.stale = true;
            internal(reason, "could not save a game, so dropping it from memory")
        })?;
        // A change that has no record adds no row, and a game that hasn't started has none.
        self.last_record = record.or(self.last_record.take());
        Ok(())
    }

    /// Tells everyone connected about the game as it now is. `state` is the game's JSON.
    fn publish(&self, state: Option<Value>) {
        self.snapshots.send_replace(Arc::new(Snapshot {
            game_id: self.id.clone(),
            kind: self.engine.kind(),
            revision: self.revision,
            state_version: self.engine.state_version(),
            players: self.players.clone(),
            player_names: self.who.names.clone(),
            player_guests: self.who.guests.clone(),
            state,
            rematch: self.rematch.clone(),
        }));
    }
}

/// Who a game's players are, besides their ids: what clients are shown, and what the room needs
/// to know about them. All by seat.
#[derive(Debug, Clone, PartialEq, Default)]
struct Who {
    /// The display names: null for one who hasn't picked a name. A registered user's name is
    /// their username.
    names: Vec<Option<String>>,
    /// Who has deleted their user. A game with one has nobody to play a rematch with.
    deleted: Vec<bool>,
    /// Who is a guest: has no username, and is neither a bot nor deleted. See
    /// [`Snapshot::player_guests`].
    guests: Vec<bool>,
}

/// Reads who `players` are, in their order.
async fn read_players(pool: &PgPool, players: &[Uuid]) -> Result<Who, sqlx::Error> {
    // A guest here is one in `list_games` (in `lobby`): keep the two the same.
    let rows: Vec<(Uuid, Option<String>, bool, bool)> = sqlx::query_as(
        "SELECT id, name, deleted_at IS NOT NULL,
                username IS NULL AND deleted_at IS NULL AND NOT is_bot
           FROM users WHERE id = ANY($1)",
    )
    .bind(players)
    .fetch_all(pool)
    .await?;
    let row = |player: &Uuid| rows.iter().find(|(id, ..)| id == player);
    Ok(Who {
        names: players
            .iter()
            .map(|player| row(player).and_then(|(_, name, ..)| name.clone()))
            .collect(),
        deleted: players
            .iter()
            .map(|player| row(player).is_some_and(|(_, _, deleted, _)| *deleted))
            .collect(),
        guests: players
            .iter()
            .map(|player| row(player).is_some_and(|(.., guest)| *guest))
            .collect(),
    })
}

/// The game's state as JSON, to store and to send. Null for a game that hasn't started.
fn to_json(live: Option<&dyn Live>) -> Result<Option<Value>, RoomError> {
    live.map(|live| live.to_json())
        .transpose()
        .map_err(|err| internal(err, "could not write a game state as JSON"))
}

/// The game's state as the history keeps it (see `history`). Null for a game that hasn't started.
fn to_record(live: Option<&dyn Live>) -> Result<Option<Value>, RoomError> {
    live.map(|live| live.to_record())
        .transpose()
        .map_err(|err| internal(err, "could not write a game state as JSON for the history"))
}

/// Logs what went wrong and gives the error that goes to the requester.
fn internal(err: impl std::fmt::Display, context: &str) -> RoomError {
    tracing::error!(%err, "{context}");
    RoomError::Internal
}

/// A game to store, with its players, who take seats in the order given.
struct NewGame {
    kind: &'static str,
    state_version: i32,
    players: Vec<Uuid>,
    /// Null for a game that waits for more players.
    state: Option<Value>,
    /// The state as the history keeps it: there exactly when `state` is.
    record: Option<Value>,
    finished: bool,
    /// Whether the game is in the public list once it has started.
    public: bool,
}

impl NewGame {
    /// A game of `engine`'s kind for `players`, in the state `live` if it has started.
    fn new(
        engine: &dyn Engine,
        players: Vec<Uuid>,
        live: Option<&dyn Live>,
        public: bool,
    ) -> Result<Self, RoomError> {
        Ok(Self {
            kind: engine.kind(),
            state_version: engine.state_version() as i32,
            players,
            state: to_json(live)?,
            record: to_record(live)?,
            finished: live.is_some_and(|live| live.is_over()),
            public,
        })
    }
}

/// Stores a new game and its players as part of the transaction `tx`, and returns its id.
/// A game that has started is in the history from its first state, at revision 0.
async fn insert_game(tx: &mut PgConnection, game: &NewGame) -> Result<GameId, String> {
    let db = |err: sqlx::Error| err.to_string();
    // A random id is taken by another game once in a very long while. Then try another.
    let mut id = None;
    for _ in 0..ID_ATTEMPTS {
        let candidate = GameId::random().map_err(|err| err.to_string())?;
        let inserted: Option<GameId> = sqlx::query_scalar(
            "INSERT INTO games (id, kind, state_version, state, finished, public)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO NOTHING
             RETURNING id",
        )
        .bind(&candidate)
        .bind(game.kind)
        .bind(game.state_version)
        .bind(&game.state)
        .bind(game.finished)
        .bind(game.public)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        if inserted.is_some() {
            id = Some(candidate);
            break;
        }
    }
    let id = id.ok_or("every id tried was taken")?;
    for (seat, player) in game.players.iter().enumerate() {
        sqlx::query("INSERT INTO game_players (game_id, seat, user_id) VALUES ($1, $2, $3)")
            .bind(&id)
            .bind(seat as i16)
            .bind(player)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    if let Some(record) = &game.record {
        history::insert(tx, &id, 0, game.state_version, None, record).await?;
    }
    Ok(id)
}

/// One change to the rematch of a stored game.
struct RematchChange<'a> {
    game_id: &'a GameId,
    /// The revision the change builds on.
    from_revision: i64,
    /// What the rematch becomes. Ignored if `new_game` is set.
    rematch: Option<&'a Rematch>,
    /// The game that the rematch is for. It is stored with the change, and the rematch becomes
    /// [`Rematch::Accepted`] with its id.
    new_game: Option<NewGame>,
}

/// Stores a change to the rematch in one transaction, as revision `from_revision + 1`, along
/// with the new game if there is one. Fails, and leaves no new game behind, if the game is no
/// longer at `from_revision`, i.e. somebody else changed it. The error is for the log.
/// Returns the rematch as stored.
async fn write_rematch(
    pool: &PgPool,
    change: RematchChange<'_>,
) -> Result<Option<Rematch>, String> {
    let db = |err: sqlx::Error| err.to_string();
    let mut tx = pool.begin().await.map_err(db)?;
    let rematch = match &change.new_game {
        Some(game) => Some(Rematch::Accepted {
            game_id: insert_game(&mut tx, game).await?,
        }),
        None => change.rematch.cloned(),
    };
    let stored = rematch
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|err| err.to_string())?;
    let updated = sqlx::query(
        "UPDATE games
         SET rematch = $2, revision = revision + 1, updated_at = now()
         WHERE id = $1 AND revision = $3",
    )
    .bind(change.game_id)
    .bind(&stored)
    .bind(change.from_revision)
    .execute(&mut *tx)
    .await
    .map_err(db)?
    .rows_affected();
    if updated != 1 {
        return Err(format!(
            "game is no longer at revision {}",
            change.from_revision
        ));
    }
    tx.commit().await.map_err(db)?;
    Ok(rematch)
}

/// One change to a stored game.
struct Change<'a> {
    game_id: &'a GameId,
    /// The revision the change builds on.
    from_revision: i64,
    state_version: i32,
    new_player: Option<(usize, Uuid)>,
    state: Option<&'a Value>,
    /// The record of the latest row the game's history has, if the writer wrote it and so
    /// knows it: what a row can hold only the difference to.
    previous: Option<&'a Value>,
    /// The state as the history keeps it: there exactly when `state` is. It goes into the
    /// history under the revision of the change.
    record: Option<&'a Value>,
    /// The game has ended with this state.
    finished: bool,
}

/// Stores a change in one transaction, as revision `from_revision + 1`, along with its state
/// in the game's history. Fails, and leaves nothing behind, if the game is no longer at
/// `from_revision`, i.e. somebody else changed it. The error is for the log.
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
    if let Some(record) = change.record {
        let revision = change.from_revision + 1;
        history::insert(
            &mut tx,
            change.game_id,
            revision,
            change.state_version,
            change.previous,
            record,
        )
        .await?;
    }
    tx.commit().await.map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_util::{
        Cells, Quick, SLOW_THINKING, STUCK_ASKED, Slow, Solo, Stuck, TEST_BOT_PAUSE, Tally,
        TallyV2, TestApp, eventually,
    };

    /// Short enough to wait out in a test.
    const GRACE: Duration = Duration::from_millis(50);

    fn tally() -> Games {
        Games::default()
            .with::<Tally>()
            .with::<Solo>()
            .with::<Quick>()
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
        rooms.create(&engine, creator, false).await.unwrap()
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
                // A user made by `user` is a guest.
                player_guests: vec![true],
                state: None,
                rematch: None,
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
            .create(rooms.games().get("solo").unwrap(), player, false)
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
        bot_game_at(rooms, creator, Level::Medium).await
    }

    /// A tally game against the bot of the given level, which adds 2 if it is easy and 3 if hard.
    async fn bot_game_at(rooms: &Rooms, creator: Uuid, level: Level) -> GameId {
        let engine = rooms.games().get("tally").unwrap().clone();
        rooms
            .create_against_bot(&engine, creator, level, false)
            .await
            .unwrap()
    }

    #[sqlx::test]
    async fn a_game_against_the_bot_has_it_seated_and_has_begun(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;

        let id = bot_game(&rooms, creator).await;

        let mut connection = rooms.connect(&id, creator).await.unwrap();
        let snapshot = connection.latest();
        assert_eq!(snapshot.players, [creator, Level::Medium.user()]);
        assert_eq!(snapshot.player_names, [None, Some("Medium bot".to_owned())]);
        assert_eq!(snapshot.state, Some(json!({ "total": 0, "turn": 0 })));
    }

    #[sqlx::test]
    async fn a_game_without_a_bot_cannot_be_played_against_one(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;
        let solo = rooms.games().get("solo").unwrap().clone();

        let result = rooms
            .create_against_bot(&solo, creator, Level::Medium, false)
            .await;

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
    async fn the_bot_plays_at_the_level_it_was_asked_for(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;
        for (level, adds) in [(Level::Easy, 2), (Level::Medium, 1), (Level::Hard, 3)] {
            let id = bot_game_at(&rooms, creator, level).await;
            let mut connection = rooms.connect(&id, creator).await.unwrap();
            assert_eq!(connection.latest().players, [creator, level.user()]);

            connection.act(add(10)).await.unwrap();

            next(&mut connection).await; // The player's own move.
            let after_bot = next(&mut connection).await;
            assert_eq!(
                after_bot.state,
                Some(json!({ "total": 10 + adds, "turn": 0 })),
                "{level:?}"
            );
        }
    }

    /// A game of the given kind against the bot (at the middle level), for `creator`.
    async fn bot_game_of(rooms: &Rooms, kind: &str, creator: Uuid) -> GameId {
        let engine = rooms.games().get(kind).unwrap().clone();
        rooms
            .create_against_bot(&engine, creator, Level::Medium, false)
            .await
            .unwrap()
    }

    #[sqlx::test]
    async fn a_room_goes_on_serving_while_its_bot_thinks(pool: PgPool) {
        let rooms = rooms(&pool, Games::default().with::<Slow>());
        let creator = user(&pool).await;
        let id = bot_game_of(&rooms, "slow", creator).await;
        let mut connection = rooms.connect(&id, creator).await.unwrap();
        connection.act(add(1)).await.unwrap();
        next(&mut connection).await;
        // The bot is due after its pause, and is then busy for `SLOW_THINKING`.
        tokio::time::sleep(TEST_BOT_PAUSE * 4).await;

        // Whatever the room does meanwhile is answered at once, and so is every other task on
        // the thread: a second connection is made, and a timer keeps its time.
        let before = Instant::now();
        let second = rooms.connect(&id, creator).await.unwrap();
        tokio::time::sleep(Duration::from_millis(10)).await;
        let waited = before.elapsed();

        assert!(
            waited < SLOW_THINKING / 2,
            "the room was held up for {waited:?} by the bot"
        );
        drop(second);
        // The bot's move arrives when it is done.
        let after_bot = next(&mut connection).await;
        assert_eq!(
            after_bot.state,
            Some(json!({ "total": 2, "turn": 0, "over": false }))
        );
    }

    #[sqlx::test]
    async fn a_move_the_bot_was_working_out_is_dropped_when_the_game_has_changed(pool: PgPool) {
        let rooms = rooms(&pool, Games::default().with::<Slow>());
        let creator = user(&pool).await;
        let id = bot_game_of(&rooms, "slow", creator).await;
        let mut connection = rooms.connect(&id, creator).await.unwrap();
        connection.act(add(1)).await.unwrap();
        next(&mut connection).await;
        tokio::time::sleep(TEST_BOT_PAUSE * 4).await;

        // The player gives up while the bot is still thinking.
        connection.forfeit().await.unwrap();
        let over = next(&mut connection).await;
        assert_eq!(
            over.state,
            Some(json!({ "total": 1, "turn": 1, "over": true }))
        );
        tokio::time::sleep(SLOW_THINKING * 2).await;

        // The bot's move was for a game that isn't there any more: nothing is made of it.
        assert_quiet(&mut connection).await;
        assert_eq!(
            stored(&pool, &id).await,
            (2, 1, Some(json!({ "total": 1, "turn": 1, "over": true })))
        );
    }

    #[sqlx::test]
    async fn a_bot_that_has_no_move_on_its_turn_is_not_asked_again_until_the_game_changes(
        pool: PgPool,
    ) {
        let rooms = rooms(&pool, Games::default().with::<Stuck>());
        let creator = user(&pool).await;
        let id = bot_game_of(&rooms, "stuck", creator).await;
        let mut connection = rooms.connect(&id, creator).await.unwrap();
        connection.act(add(1)).await.unwrap();
        next(&mut connection).await;

        // Many times what it takes the room to ask once.
        tokio::time::sleep(TEST_BOT_PAUSE * 15).await;

        assert_eq!(STUCK_ASKED.load(std::sync::atomic::Ordering::SeqCst), 1);
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

    // --- The rematch ---

    /// A `quick` game, which is over as soon as somebody acts, for `first` and `second`.
    /// Already over, and nobody is connected to it.
    async fn finished_game(rooms: &Rooms, first: Uuid, second: Uuid) -> GameId {
        let engine = rooms.games().get("quick").unwrap().clone();
        let id = rooms.create(&engine, first, false).await.unwrap();
        rooms.join(&id, second).await.unwrap();
        let connection = rooms.connect(&id, first).await.unwrap();
        connection.act(json!({})).await.unwrap();
        id
    }

    /// What the database holds as a game's rematch.
    async fn stored_rematch(pool: &PgPool, id: &GameId) -> Option<Value> {
        sqlx::query_scalar("SELECT rematch FROM games WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn players_of(pool: &PgPool, id: &GameId) -> Vec<Uuid> {
        sqlx::query_scalar("SELECT user_id FROM game_players WHERE game_id = $1 ORDER BY seat")
            .bind(id)
            .fetch_all(pool)
            .await
            .unwrap()
    }

    async fn game_count(pool: &PgPool) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM games")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// The game a rematch made, once it has been accepted.
    fn next_game(rematch: Option<Rematch>) -> GameId {
        match rematch {
            Some(Rematch::Accepted { game_id }) => game_id,
            other => panic!("expected an accepted rematch, got {other:?}"),
        }
    }

    #[sqlx::test]
    async fn asking_for_a_rematch_is_saved_and_shown_to_everyone_connected(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let id = finished_game(&rooms, ada, grace).await;
        let mut ada_connection = rooms.connect(&id, ada).await.unwrap();
        let mut grace_connection = rooms.connect(&id, grace).await.unwrap();
        let before = ada_connection.latest();
        grace_connection.latest();

        let reply = rooms.ask_rematch(&id, ada).await;

        assert_eq!(reply, Ok(Some(Rematch::Offered { by: 0 })));
        for connection in [&mut ada_connection, &mut grace_connection] {
            let snapshot = next(connection).await;
            assert_eq!(snapshot.rematch, Some(Rematch::Offered { by: 0 }));
            assert_eq!(snapshot.revision, before.revision + 1);
            // The game is as it was: only what the players have agreed on is new.
            assert_eq!(snapshot.state, before.state);
        }
        assert_eq!(
            stored_rematch(&pool, &id).await,
            Some(json!({ "type": "offered", "by": 0 }))
        );
        assert_eq!(stored(&pool, &id).await.0, before.revision + 1);
    }

    #[sqlx::test]
    async fn the_other_player_saying_yes_starts_a_new_game_for_the_same_players(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let id = finished_game(&rooms, ada, grace).await;
        let mut ada_connection = rooms.connect(&id, ada).await.unwrap();
        ada_connection.latest();
        rooms.ask_rematch(&id, ada).await.unwrap();
        next(&mut ada_connection).await;

        let reply = rooms.ask_rematch(&id, grace).await.unwrap();

        // The game that follows has started, with the players in the seats they had.
        let following = next_game(reply);
        assert_ne!(following, id);
        assert_eq!(players_of(&pool, &following).await, [ada, grace]);
        assert_eq!(
            stored(&pool, &following).await,
            (0, 1, Some(json!({ "over": false })))
        );
        assert!(!finished(&pool, &following).await);
        // The old one says where it went, to the players connected and to a database reader.
        let snapshot = next(&mut ada_connection).await;
        assert_eq!(
            snapshot.rematch,
            Some(Rematch::Accepted {
                game_id: following.clone()
            })
        );
        assert_eq!(
            stored_rematch(&pool, &id).await,
            Some(json!({ "type": "accepted", "gameId": following.to_string() }))
        );
        // And it is ready for the players who are about to connect to it.
        assert!(rooms.is_open(&following));
    }

    #[sqlx::test]
    async fn the_old_game_stays_as_it_ended(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let id = finished_game(&rooms, ada, grace).await;
        let (_, _, state) = stored(&pool, &id).await;
        rooms.ask_rematch(&id, ada).await.unwrap();

        rooms.ask_rematch(&id, grace).await.unwrap();

        assert_eq!(stored(&pool, &id).await.2, state);
        assert!(finished(&pool, &id).await);
        assert_eq!(players_of(&pool, &id).await, [ada, grace]);
    }

    #[sqlx::test]
    async fn two_players_asking_at_the_same_time_get_one_new_game(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let id = finished_game(&rooms, ada, grace).await;

        let (a, b) = tokio::join!(rooms.ask_rematch(&id, ada), rooms.ask_rematch(&id, grace));

        // Whoever got in first made the offer, and the other one's ask answered it.
        let replies = [a.unwrap(), b.unwrap()];
        assert!(
            replies
                .iter()
                .any(|reply| matches!(reply, Some(Rematch::Offered { .. }))),
            "{replies:?}"
        );
        assert!(
            replies
                .iter()
                .any(|reply| matches!(reply, Some(Rematch::Accepted { .. }))),
            "{replies:?}"
        );
        assert_eq!(game_count(&pool).await, 2);
    }

    #[sqlx::test]
    async fn asking_again_changes_nothing(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let id = finished_game(&rooms, ada, grace).await;
        rooms.ask_rematch(&id, ada).await.unwrap();
        let after_ask = stored(&pool, &id).await.0;

        let again = rooms.ask_rematch(&id, ada).await;

        assert_eq!(again, Ok(Some(Rematch::Offered { by: 0 })));
        assert_eq!(stored(&pool, &id).await.0, after_ask);
    }

    #[sqlx::test]
    async fn a_rematch_that_has_started_cannot_be_started_twice(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let id = finished_game(&rooms, ada, grace).await;
        rooms.ask_rematch(&id, ada).await.unwrap();
        let following = next_game(rooms.ask_rematch(&id, grace).await.unwrap());

        // Anyone asking now is pointed at the game that exists.
        for player in [ada, grace] {
            let reply = rooms.ask_rematch(&id, player).await.unwrap();
            assert_eq!(next_game(reply), following);
        }

        assert_eq!(game_count(&pool).await, 2);
    }

    #[sqlx::test]
    async fn turning_down_an_offer_tells_the_one_who_made_it(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let id = finished_game(&rooms, ada, grace).await;
        let mut ada_connection = rooms.connect(&id, ada).await.unwrap();
        ada_connection.latest();
        rooms.ask_rematch(&id, ada).await.unwrap();
        next(&mut ada_connection).await;

        let reply = rooms.decline_rematch(&id, grace).await;

        assert_eq!(reply, Ok(Some(Rematch::Declined { by: 0 })));
        let snapshot = next(&mut ada_connection).await;
        assert_eq!(snapshot.rematch, Some(Rematch::Declined { by: 0 }));
        assert_eq!(game_count(&pool).await, 1);
        // Either of them can still ask later.
        let asked_again = rooms.ask_rematch(&id, ada).await;
        assert_eq!(asked_again, Ok(Some(Rematch::Offered { by: 0 })));
    }

    #[sqlx::test]
    async fn the_one_who_said_no_can_change_their_mind_by_asking(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let id = finished_game(&rooms, ada, grace).await;
        rooms.ask_rematch(&id, ada).await.unwrap();
        rooms.decline_rematch(&id, grace).await.unwrap();

        let reply = rooms.ask_rematch(&id, grace).await;

        // It is an offer from Grace now, for Ada to answer.
        assert_eq!(reply, Ok(Some(Rematch::Offered { by: 1 })));
    }

    #[sqlx::test]
    async fn taking_back_your_own_ask_leaves_no_rematch(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let id = finished_game(&rooms, ada, grace).await;
        let mut grace_connection = rooms.connect(&id, grace).await.unwrap();
        grace_connection.latest();
        rooms.ask_rematch(&id, ada).await.unwrap();
        next(&mut grace_connection).await;

        let reply = rooms.decline_rematch(&id, ada).await;

        assert_eq!(reply, Ok(None));
        assert_eq!(next(&mut grace_connection).await.rematch, None);
        assert_eq!(stored_rematch(&pool, &id).await, None);
    }

    #[sqlx::test]
    async fn declining_with_nothing_to_decline_changes_nothing(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let id = finished_game(&rooms, ada, grace).await;
        let before = stored(&pool, &id).await;

        let reply = rooms.decline_rematch(&id, grace).await;

        assert_eq!(reply, Ok(None));
        assert_eq!(stored(&pool, &id).await, before);
    }

    #[sqlx::test]
    async fn a_game_that_is_not_over_has_no_rematch(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let engine = rooms.games().get("quick").unwrap().clone();
        let waiting = rooms.create(&engine, ada, false).await.unwrap();
        let playing = started_game(&rooms, ada, grace).await;

        for id in [&waiting, &playing] {
            assert_eq!(
                rooms.ask_rematch(id, ada).await,
                Err(RoomError::NotOver),
                "{id}"
            );
            assert_eq!(
                rooms.decline_rematch(id, ada).await,
                Err(RoomError::NotOver),
                "{id}"
            );
        }
        assert_eq!(game_count(&pool).await, 2);
    }

    #[sqlx::test]
    async fn only_a_player_can_ask_or_answer(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace, outsider) = (user(&pool).await, user(&pool).await, user(&pool).await);
        let id = finished_game(&rooms, ada, grace).await;
        rooms.ask_rematch(&id, ada).await.unwrap();

        assert_eq!(
            rooms.ask_rematch(&id, outsider).await,
            Err(RoomError::NotAPlayer)
        );
        assert_eq!(
            rooms.decline_rematch(&id, outsider).await,
            Err(RoomError::NotAPlayer)
        );
        // Nothing the outsider did counted.
        assert_eq!(
            stored_rematch(&pool, &id).await,
            Some(json!({ "type": "offered", "by": 0 }))
        );
    }

    #[sqlx::test]
    async fn a_game_for_one_player_has_no_rematch(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let player = user(&pool).await;
        let id = rooms
            .create(rooms.games().get("solo").unwrap(), player, false)
            .await
            .unwrap();
        let connection = rooms.connect(&id, player).await.unwrap();
        for _ in 0..3 {
            connection.act(json!({})).await.unwrap();
        }
        assert!(finished(&pool, &id).await);

        let reply = rooms.ask_rematch(&id, player).await;

        assert_eq!(reply, Err(RoomError::NoRematch));
        assert_eq!(game_count(&pool).await, 1);
    }

    #[sqlx::test]
    async fn a_rematch_against_the_bot_is_against_the_same_level(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let player = user(&pool).await;
        let engine = rooms.games().get("quick").unwrap().clone();
        for level in [Level::Easy, Level::Hard] {
            let id = rooms
                .create_against_bot(&engine, player, level, false)
                .await
                .unwrap();
            let connection = rooms.connect(&id, player).await.unwrap();
            connection.act(json!({})).await.unwrap();

            let reply = rooms.ask_rematch(&id, player).await.unwrap();

            let following = next_game(reply);
            assert_eq!(
                players_of(&pool, &following).await,
                [player, level.user()],
                "{level:?}"
            );
        }
    }

    #[sqlx::test]
    async fn the_bot_agrees_to_a_rematch_at_once(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let player = user(&pool).await;
        let engine = rooms.games().get("quick").unwrap().clone();
        let id = rooms
            .create_against_bot(&engine, player, Level::Medium, false)
            .await
            .unwrap();
        let mut connection = rooms.connect(&id, player).await.unwrap();
        connection.act(json!({})).await.unwrap();
        connection.latest();

        let reply = rooms.ask_rematch(&id, player).await.unwrap();

        let following = next_game(reply);
        assert_eq!(
            players_of(&pool, &following).await,
            [player, Level::Medium.user()]
        );
        assert_eq!(
            stored(&pool, &following).await,
            (0, 1, Some(json!({ "over": false })))
        );
        // The player's page hears about it as a snapshot, with no offer on the way.
        assert_eq!(
            next(&mut connection).await.rematch,
            Some(Rematch::Accepted { game_id: following })
        );
    }

    #[sqlx::test]
    async fn a_rematch_is_still_there_when_the_game_is_loaded_again(pool: PgPool) {
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let before = rooms(&pool, tally());
        let id = finished_game(&before, ada, grace).await;
        before.ask_rematch(&id, ada).await.unwrap();
        eventually("the game is unloaded", || !before.is_open(&id)).await;

        // A new set of rooms is as empty as after a restart.
        let after = rooms(&pool, tally());
        let mut connection = after.connect(&id, grace).await.unwrap();

        assert_eq!(
            connection.latest().rematch,
            Some(Rematch::Offered { by: 0 })
        );
        // And it can be answered where it was left.
        let reply = after.ask_rematch(&id, grace).await.unwrap();
        assert_eq!(players_of(&pool, &next_game(reply)).await, [ada, grace]);
    }

    #[sqlx::test]
    async fn a_rematch_that_cannot_be_saved_leaves_no_game_behind(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let id = finished_game(&rooms, ada, grace).await;
        rooms.ask_rematch(&id, ada).await.unwrap();
        // Somebody else changes the game behind the room's back.
        sqlx::query("UPDATE games SET revision = revision + 1 WHERE id = $1")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();

        let reply = rooms.ask_rematch(&id, grace).await;

        assert_eq!(reply, Err(RoomError::Internal));
        // The game and its new game are saved together or not at all.
        assert_eq!(game_count(&pool).await, 1);
        eventually("the room shuts down", || !rooms.is_open(&id)).await;
    }

    // --- The history ---

    /// The game's history as the database holds it, with every delta applied: revision, state
    /// version and state, oldest first.
    async fn history_of(pool: &PgPool, id: &GameId) -> Vec<(i64, i32, Value)> {
        let rows: Vec<history::StoredRow> = sqlx::query_as(
            "SELECT revision, state_version, state, delta FROM game_history
             WHERE game_id = $1 ORDER BY revision",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .unwrap();
        history::unfold(rows).unwrap()
    }

    /// The rows of the game's history as they are stored: revision, state and delta, oldest
    /// first.
    async fn rows_of(pool: &PgPool, id: &GameId) -> Vec<(i64, Option<Value>, Option<Value>)> {
        sqlx::query_as(
            "SELECT revision, state, delta FROM game_history
             WHERE game_id = $1 ORDER BY revision",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .unwrap()
    }

    fn tallied(total: i64, turn: usize) -> Value {
        json!({ "total": total, "turn": turn })
    }

    #[sqlx::test]
    async fn a_game_that_waits_for_a_player_has_no_history(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;

        let id = waiting_game(&rooms, creator).await;

        assert_eq!(history_of(&pool, &id).await, []);
    }

    #[sqlx::test]
    async fn the_history_begins_when_the_last_player_joins(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);

        let id = started_game(&rooms, first, second).await;

        assert_eq!(history_of(&pool, &id).await, [(1, 1, tallied(0, 0))]);
    }

    fn cells() -> Games {
        Games::default().with::<Cells>()
    }

    /// A game of cells with `first` in seat 0 and `second` in seat 1.
    async fn started_cells(rooms: &Rooms, first: Uuid, second: Uuid) -> GameId {
        let engine = rooms.games().get("cells").unwrap().clone();
        let id = rooms.create(&engine, first, false).await.unwrap();
        rooms.join(&id, second).await.unwrap();
        id
    }

    fn cell(cell: usize) -> Value {
        json!({ "cell": cell })
    }

    /// The state of a game of cells: the counters on the cells that have any, and whose turn it is.
    fn marked(counters: &[(usize, u8)], turn: usize) -> Value {
        let mut cells = [0u8; 20];
        for &(cell, count) in counters {
            cells[cell] = count;
        }
        json!({ "cells": cells, "turn": turn })
    }

    #[sqlx::test]
    async fn a_row_after_the_first_holds_only_what_changed(pool: PgPool) {
        let rooms = rooms(&pool, cells());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_cells(&rooms, first, second).await;
        let ada = rooms.connect(&id, first).await.unwrap();
        let grace = rooms.connect(&id, second).await.unwrap();

        ada.act(cell(3)).await.unwrap();
        grace.act(cell(5)).await.unwrap();

        assert_eq!(
            rows_of(&pool, &id).await,
            [
                (1, Some(marked(&[], 0)), None),
                (2, None, Some(json!([[["cells", 3], 1], [["turn"], 1]]))),
                (3, None, Some(json!([[["cells", 5], 1], [["turn"], 0]]))),
            ]
        );
        // Read back, they are the states the game was in.
        assert_eq!(
            history_of(&pool, &id).await,
            [
                (1, 1, marked(&[], 0)),
                (2, 1, marked(&[(3, 1)], 1)),
                (3, 1, marked(&[(3, 1), (5, 1)], 0)),
            ]
        );
    }

    #[sqlx::test]
    async fn a_room_that_loads_a_game_writes_a_whole_state_first(pool: PgPool) {
        let rooms = rooms(&pool, cells());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_cells(&rooms, first, second).await;
        let ada = rooms.connect(&id, first).await.unwrap();
        let grace = rooms.connect(&id, second).await.unwrap();
        ada.act(cell(3)).await.unwrap();
        grace.act(cell(5)).await.unwrap();
        // The room goes, as it does when nobody is there. The next one has to load the game
        // and doesn't know what the rows before hold, which an older server may have written.
        rooms.close(std::slice::from_ref(&id));
        eventually("the room shuts down", || !rooms.is_open(&id)).await;
        let ada = rooms.connect(&id, first).await.unwrap();
        let grace = rooms.connect(&id, second).await.unwrap();

        ada.act(cell(7)).await.unwrap();
        grace.act(cell(9)).await.unwrap();

        let rows = rows_of(&pool, &id).await;
        let kept: Vec<_> = rows
            .iter()
            .map(|(revision, state, _)| (*revision, state.is_some()))
            .collect();
        assert_eq!(
            kept,
            [(1, true), (2, false), (3, false), (4, true), (5, false)]
        );
        assert_eq!(
            history_of(&pool, &id).await.last(),
            Some(&(5, 1, marked(&[(3, 1), (5, 1), (7, 1), (9, 1)], 0)))
        );
    }

    #[sqlx::test]
    async fn a_state_that_a_delta_would_not_shorten_is_kept_whole(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let ada = rooms.connect(&id, first).await.unwrap();

        ada.act(add(5)).await.unwrap();

        // `{"total":5,"turn":1}` is shorter than the two changes that lead to it.
        assert_eq!(
            rows_of(&pool, &id).await,
            [
                (1, Some(tallied(0, 0)), None),
                (2, Some(tallied(5, 1)), None)
            ]
        );
    }

    #[sqlx::test]
    async fn a_state_is_kept_as_compact_json_text(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);

        let id = started_game(&rooms, first, second).await;

        // A history has a row for every step of a game, so the size of a row matters: `jsonb`
        // would be some three times as large, and a `Value` bound as `jsonb` would come back
        // out of its cast to `json` with spaces added.
        let (kind, text): (String, String) = sqlx::query_as(
            "SELECT pg_typeof(state)::text, state::text FROM game_history WHERE game_id = $1",
        )
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(kind, "json");
        assert_eq!(text, tallied(0, 0).to_string());
        assert!(!text.contains(' '));
    }

    #[sqlx::test]
    async fn every_accepted_action_adds_the_state_it_led_to(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let ada = rooms.connect(&id, first).await.unwrap();
        let grace = rooms.connect(&id, second).await.unwrap();

        ada.act(add(1)).await.unwrap();
        grace.act(add(2)).await.unwrap();
        ada.act(add(3)).await.unwrap();

        assert_eq!(
            history_of(&pool, &id).await,
            [
                (1, 1, tallied(0, 0)),
                (2, 1, tallied(1, 1)),
                (3, 1, tallied(3, 0)),
                (4, 1, tallied(6, 1)),
            ]
        );
        // The newest state of the history is the game's own.
        assert_eq!(stored(&pool, &id).await.2, Some(tallied(6, 1)));
    }

    #[sqlx::test]
    async fn a_refused_action_adds_nothing_to_the_history(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let grace = rooms.connect(&id, second).await.unwrap();

        // It is Ada's turn.
        assert!(grace.act(add(5)).await.is_err());

        assert_eq!(history_of(&pool, &id).await, [(1, 1, tallied(0, 0))]);
    }

    #[sqlx::test]
    async fn a_game_that_starts_when_it_is_made_has_its_first_state_at_revision_zero(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;
        let solo = rooms.games().get("solo").unwrap().clone();

        let alone = rooms.create(&solo, creator, false).await.unwrap();
        let against_bot = bot_game(&rooms, creator).await;

        assert_eq!(
            history_of(&pool, &alone).await,
            [(0, 1, json!({ "count": 0 }))]
        );
        assert_eq!(
            history_of(&pool, &against_bot).await,
            [(0, 1, tallied(0, 0))]
        );
    }

    #[sqlx::test]
    async fn the_bots_moves_are_in_the_history_like_the_players(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let creator = user(&pool).await;
        let id = bot_game(&rooms, creator).await;
        let mut connection = rooms.connect(&id, creator).await.unwrap();

        connection.act(add(5)).await.unwrap();
        next(&mut connection).await;
        next(&mut connection).await;

        assert_eq!(
            history_of(&pool, &id).await,
            [
                (0, 1, tallied(0, 0)),
                (1, 1, tallied(5, 1)),
                (2, 1, tallied(6, 0)),
            ]
        );
    }

    #[sqlx::test]
    async fn a_rematch_adds_nothing_to_the_old_history_and_starts_the_new_one(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (ada, grace) = (user(&pool).await, user(&pool).await);
        let id = finished_game(&rooms, ada, grace).await;
        let over = vec![
            (1, 1, json!({ "over": false })),
            (2, 1, json!({ "over": true })),
        ];
        assert_eq!(history_of(&pool, &id).await, over);

        rooms.ask_rematch(&id, ada).await.unwrap();
        rooms.decline_rematch(&id, grace).await.unwrap();
        rooms.ask_rematch(&id, grace).await.unwrap();
        let reply = rooms.ask_rematch(&id, ada).await.unwrap();

        // The revisions rose by the offer, the refusal, the new offer and its answer, but the
        // game was in the same state through all of them.
        assert_eq!(stored(&pool, &id).await.0, 6);
        assert_eq!(history_of(&pool, &id).await, over);
        assert_eq!(
            history_of(&pool, &next_game(reply)).await,
            [(0, 1, json!({ "over": false }))]
        );
    }

    #[sqlx::test]
    async fn a_player_changing_their_name_adds_nothing_to_the_history(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let mut ada = rooms.connect(&id, first).await.unwrap();
        ada.latest();

        sqlx::query("UPDATE users SET name = 'Ada' WHERE id = $1")
            .bind(first)
            .execute(&pool)
            .await
            .unwrap();
        rooms.name_changed(first);
        next(&mut ada).await;

        assert_eq!(history_of(&pool, &id).await, [(1, 1, tallied(0, 0))]);
    }

    #[sqlx::test]
    async fn a_save_that_is_refused_leaves_nothing_in_the_history(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let ada = rooms.connect(&id, first).await.unwrap();
        // Somebody else changes the game behind the room's back.
        sqlx::query("UPDATE games SET revision = revision + 1 WHERE id = $1")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();

        assert_eq!(ada.act(add(5)).await, Err(RoomError::Internal));

        assert_eq!(history_of(&pool, &id).await, [(1, 1, tallied(0, 0))]);
    }

    #[sqlx::test]
    async fn a_state_is_saved_with_its_history_or_not_at_all(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        let ada = rooms.connect(&id, first).await.unwrap();
        // The history already has a state at the revision the action would make.
        sqlx::query(
            "INSERT INTO game_history (game_id, revision, state_version, state)
             VALUES ($1, 2, 1, '{}')",
        )
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(ada.act(add(5)).await, Err(RoomError::Internal));

        // The game did not move on without its history.
        assert_eq!(stored(&pool, &id).await, (1, 1, Some(tallied(0, 0))));
    }

    #[sqlx::test]
    async fn the_history_goes_with_the_game(pool: PgPool) {
        let rooms = rooms(&pool, tally());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let id = started_game(&rooms, first, second).await;
        assert_eq!(history_of(&pool, &id).await.len(), 1);

        sqlx::query("DELETE FROM games WHERE id = $1")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();

        assert_eq!(history_of(&pool, &id).await, []);
    }

    #[sqlx::test]
    async fn a_whole_long_backgammon_game_leaves_a_history_the_server_can_load(pool: PgPool) {
        let rooms = rooms(
            &pool,
            Games::default().with::<crate::long_backgammon::LongBackgammon>(),
        );
        let (first, second) = (user(&pool).await, user(&pool).await);
        let engine = rooms.games().get("long-backgammon").unwrap().clone();
        let id = rooms.create(&engine, first, false).await.unwrap();
        rooms.join(&id, second).await.unwrap();
        // By seat.
        let mut players = [
            rooms.connect(&id, first).await.unwrap(),
            rooms.connect(&id, second).await.unwrap(),
        ];

        // Whoever is to move rolls, or plays the first step the server lists as legal.
        let mut actions = 0;
        loop {
            let state = players[0]
                .latest()
                .state
                .clone()
                .expect("the game has started");
            let action = match state["phase"]["type"].as_str().unwrap() {
                "roll" => json!({ "type": "roll" }),
                "move" => {
                    let step = &state["legal"][0];
                    json!({ "type": "move", "from": step["from"], "die": step["die"] })
                }
                _ => break,
            };
            let seat = state["turn"].as_u64().unwrap() as usize;
            players[seat].act(action).await.unwrap();
            actions += 1;
            assert!(actions < 5000, "the game does not end");
        }

        // The record leaves out what the game works out again.
        assert_history_loads(
            &pool,
            &engine,
            &id,
            actions,
            &["legal", "combos"],
            players[0].latest().state.clone(),
        )
        .await;
    }

    #[sqlx::test]
    async fn a_whole_ultimate_tic_tac_toe_game_leaves_a_history_the_server_can_load(pool: PgPool) {
        let rooms = rooms(
            &pool,
            Games::default().with::<crate::ultimate_tic_tac_toe::UltimateTicTacToe>(),
        );
        let (first, second) = (user(&pool).await, user(&pool).await);
        let engine = rooms.games().get("ultimate-tic-tac-toe").unwrap().clone();
        let id = rooms.create(&engine, first, false).await.unwrap();
        rooms.join(&id, second).await.unwrap();
        // By seat.
        let mut players = [
            rooms.connect(&id, first).await.unwrap(),
            rooms.connect(&id, second).await.unwrap(),
        ];

        // Whoever is to move marks the first empty cell of the first board the server lists.
        let mut actions = 0;
        loop {
            let state = players[0]
                .latest()
                .state
                .clone()
                .expect("the game has started");
            if state["phase"]["type"] != "play" {
                break;
            }
            let board = state["playable"][0].as_u64().unwrap() as usize;
            let cell = (0..9)
                .find(|&cell| state["cells"][board][cell].is_null())
                .expect("a playable board has an empty cell");
            let seat = state["turn"].as_u64().unwrap() as usize;
            players[seat]
                .act(json!({ "type": "play", "board": board, "cell": cell }))
                .await
                .unwrap();
            actions += 1;
            assert!(actions <= 81, "the game does not end");
        }
        assert!(actions >= 9, "a game is at least nine marks long");

        // The record keeps what a client needs to draw a past position, and only the boards the
        // player to move may play in are left out (the history puts them back, see `history`).
        assert_history_loads(
            &pool,
            &engine,
            &id,
            actions,
            &["playable"],
            players[0].latest().state.clone(),
        )
        .await;
        for (_, _, state) in history_of(&pool, &id).await {
            assert!(state.get("boards").is_some() && state.get("line").is_some());
        }
    }

    #[sqlx::test]
    async fn a_whole_hex_game_with_a_swap_leaves_a_history_the_server_can_load(pool: PgPool) {
        let rooms = rooms(&pool, Games::default().with::<crate::hex::Hex>());
        let (first, second) = (user(&pool).await, user(&pool).await);
        let engine = rooms.games().get("hex").unwrap().clone();
        let id = rooms.create(&engine, first, false).await.unwrap();
        rooms.join(&id, second).await.unwrap();
        // By seat.
        let mut players = [
            rooms.connect(&id, first).await.unwrap(),
            rooms.connect(&id, second).await.unwrap(),
        ];

        // Red opens in the centre and Blue swaps it. Then whoever is to move fills the first empty
        // cell in reading order, which connects somebody before the board is full.
        let mut actions = 0;
        loop {
            let state = players[0]
                .latest()
                .state
                .clone()
                .expect("the game has started");
            if state["phase"]["type"] != "play" {
                break;
            }
            let seat = state["turn"].as_u64().unwrap() as usize;
            let action = if actions == 0 {
                json!({ "type": "place", "column": 5, "row": 5 })
            } else if actions == 1 {
                assert_eq!(state["canSwap"], json!(true));
                json!({ "type": "swap" })
            } else {
                let cell = (0..121)
                    .find(|&cell| state["cells"][cell].is_null())
                    .expect("a game that is on has an empty cell");
                json!({ "type": "place", "column": cell % 11, "row": cell / 11 })
            };
            players[seat].act(action).await.unwrap();
            actions += 1;
            assert!(actions <= 122, "the game does not end");
        }

        // The record is the whole state.
        assert_history_loads(
            &pool,
            &engine,
            &id,
            actions,
            &[],
            players[0].latest().state.clone(),
        )
        .await;
        let history = history_of(&pool, &id).await;
        assert_eq!(history[2].2["last"]["swap"], json!(true));
        assert!(history.last().unwrap().2["chain"].is_array());
    }

    /// Checks the history of a finished game that took `actions` actions: a state for the start
    /// of the game and one for each action, each without the `left_out` fields of a state, each
    /// loading to what the game records for it, and the last one being the game as it ended, as
    /// the players were told (`told`).
    async fn assert_history_loads(
        pool: &PgPool,
        engine: &Arc<dyn Engine>,
        id: &GameId,
        actions: usize,
        left_out: &[&str],
        told: Option<Value>,
    ) {
        let history = history_of(pool, id).await;
        assert_eq!(history.len(), actions + 1);
        for (n, (revision, version, state)) in history.iter().enumerate() {
            assert_eq!(*revision, n as i64 + 1);
            for field in left_out {
                assert!(
                    state.get(field).is_none(),
                    "revision {revision} has {field}"
                );
            }
            let live = engine
                .load(*version as u32, state.clone())
                .expect("a recorded state loads");
            assert_eq!(live.to_record().as_ref(), Ok(state), "revision {revision}");
        }
        let (_, version, last) = history.last().unwrap();
        let live = engine.load(*version as u32, last.clone()).unwrap();
        assert!(live.is_over());
        assert_eq!(Some(live.to_json().unwrap()), told);
    }
}
