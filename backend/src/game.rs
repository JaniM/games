//! What a game must provide to be played in a room, and the registry of the games
//! the server offers.
//!
//! A game is a pure rules engine: it knows its state, how to start one and how an
//! action by a player changes it. It knows nothing about sockets, users or the
//! database. A room keeps a game's state in memory as the game's own type. The state
//! becomes JSON only at the edges: when it is stored (and kept in the game's history), sent
//! to clients, or read back from storage. An action is read from JSON, because that is how
//! it arrives.
//!
//! To add a game, implement [`Game`] and register it in [`registry`].

use std::{collections::HashMap, fmt, marker::PhantomData, sync::Arc};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{
    bot::Level, hex::Hex, long_backgammon::LongBackgammon, ultimate_tic_tac_toe::UltimateTicTacToe,
};

/// An action the rules don't allow. The reason goes back to the player who tried it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection(String);

impl Rejection {
    pub fn new(reason: impl Into<String>) -> Self {
        Self(reason.into())
    }

    pub fn reason(&self) -> &str {
        &self.0
    }
}

/// A state that can't be used: a stored one comes from a newer version, has no upgrade,
/// fails its upgrade or doesn't fit the game's `State`; or a state can't be written
/// as JSON. This is our fault, not the player's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateError(String);

impl StateError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A game, as the room system sees it. All of it is associated functions: the engine
/// has no instance, because everything a game remembers is in its state.
pub trait Game: 'static {
    /// Names the game in the database and in `POST /api/games`, so it must never change.
    /// Use the id of the game in the front end's catalog.
    const KIND: &'static str;

    /// The game's name as people read it, e.g. in the preview of a link to a game (see
    /// `preview`). Use the name in the front end's catalog.
    const NAME: &'static str;

    /// How many players a game has. Each takes a seat, numbered from 0 in the order they
    /// join, and the game starts when the last seat is taken.
    const PLAYERS: usize;

    /// The version of the JSON layout of [`Game::State`], starting at 1. Stored games
    /// keep the version they were written with. When a change to `State` means old rows
    /// no longer deserialize into it, bump this and make [`Game::upgrade`] handle the
    /// version you moved away from.
    const STATE_VERSION: u32;

    /// Whether the game has a computer opponent, which a player can ask for when they create
    /// a game. A game that says so must have two players and implement [`Game::bot_action`].
    const BOT: bool = false;

    /// What a room keeps in memory for a game that is being played. It is `Clone` because a bot
    /// works out its move on a thread of its own, from a copy (see [`Game::bot_action`]).
    type State: Serialize + DeserializeOwned + Clone + Send + 'static;
    type Action: DeserializeOwned;

    /// Whether the game has ended and nobody has anything more to do in it. The server
    /// records it with every state it saves, so that games can be listed as finished without
    /// loading them. A game that never ends can leave the default.
    fn is_over(state: &Self::State) -> bool {
        let _ = state;
        false
    }

    /// The state as it is kept in the game's history, which lets the game be stepped through
    /// afterwards (see `history`). A game may leave out whatever it can work out again from
    /// the rest, because the history keeps a state for every change and would otherwise
    /// store the same derived data hundreds of times.
    ///
    /// What this returns must be a state that [`Engine::load`] accepts, in the layout of
    /// [`Game::STATE_VERSION`]: a history row is brought up to date like a stored game is, and
    /// is shown by writing it as JSON again. The default keeps the whole state.
    fn record(state: &Self::State) -> Result<Value, StateError> {
        serde_json::to_value(state)
            .map_err(|err| StateError::new(format!("could not write a state as JSON: {err}")))
    }

    /// A record as a client is given it when it reads the game's history (see `history`): what
    /// [`Game::record`] left out and a client can't do without, put back. A client draws a past
    /// position without knowing the rules, and a record leaves out what can be worked out from the
    /// rest, because the history keeps one for every change. Most of what a record leaves out is of
    /// no use to a position of the past, and then this is the record as it is, which is the default.
    /// Where it is of use, and cheap, the game works it out here, when the history is read, instead
    /// of having it stored over and over.
    ///
    /// It is given the record of a state of the current layout (older ones have been brought up
    /// to date), so it is a state that [`Engine::load`] accepts.
    fn history_view(record: Value) -> Result<Value, StateError> {
        Ok(record)
    }

    /// A picture of the board for the preview of a link to the game (see `preview`): an SVG
    /// document, as wide and tall as the board, which is scaled to fit the preview. `None` for
    /// `state` is a game that hasn't started, and is the board as it is at the start, which has
    /// no randomness in it: what [`Game::start`] picks is not decided yet. Looks the same however
    /// the viewer sits, because there is no viewer; seat 0's side is the near one.
    ///
    /// Draw it in the dark colours of the site (`prefers-color-scheme: dark` in
    /// `styles/tokens.css`): the preview puts it on the dark page's background, as every game's is.
    ///
    /// The SVG is rendered without text (there are no fonts on the server), so the picture must
    /// say everything with shapes. The default is no picture, and the preview has only words.
    fn picture(state: Option<&Self::State>) -> Option<String> {
        let _ = state;
        None
    }

    /// The state of a new game, once all the seats are taken. May use randomness, e.g. to
    /// choose who begins.
    fn start() -> Self::State;

    /// The state after `seat` plays `action`, or why it can't. This must not need
    /// anything but its arguments to decide, apart from randomness such as dice.
    /// An accepted action is a new revision of the game even if it changed nothing.
    fn apply(
        state: &Self::State,
        seat: usize,
        action: Self::Action,
    ) -> Result<Self::State, Rejection>;

    /// The state after `seat` gives up the game, or why it can't. The other players win.
    ///
    /// Unlike an action it may come at any time, not only on `seat`'s turn, so it doesn't go
    /// through [`Game::apply`]. A game that is already over refuses it. The default refuses
    /// everything: a game for two or more players says how a forfeit ends it.
    ///
    /// Besides a player's own request, the server forfeits for a user who deletes their account.
    fn forfeit(state: &Self::State, seat: usize) -> Result<Self::State, Rejection> {
        let _ = (state, seat);
        Err(Rejection::new("this game can't be forfeited"))
    }

    /// Whether the computer opponent has something to play for `seat` in this state: it is
    /// `seat`'s turn and the game isn't over. A room asks this whenever anything happens in it,
    /// so it must be cheap, which is why it isn't left to [`Game::bot_action`]: that one may take
    /// a while to decide. The two agree: `bot_action` has an action exactly when this is true.
    fn bot_turn(state: &Self::State, seat: usize) -> bool {
        let _ = (state, seat);
        false
    }

    /// The action the computer opponent of the given level plays for `seat` in this state, or
    /// `None` if it has nothing to play (see [`Game::bot_turn`]). Called again after every
    /// action, so the bot needs no memory of its own, and a game that was stored half way
    /// through the bot's turn carries on from there.
    ///
    /// The action goes through [`Game::apply`] like a player's, so the bot can't break the
    /// rules; but an action the rules refuse is a bug in the bot, and leaves it with no move.
    /// Only games with [`Game::BOT`] need this, and each of them plays all three levels (see
    /// [`Level`]).
    ///
    /// **It may take a while** (a hard bot looks ahead), so it is never called on a thread that
    /// serves requests: the room runs it as a blocking job (see [`Live::bot_job`]). Keep it to a
    /// few milliseconds all the same, because the bot's opponent is waiting for it.
    fn bot_action(state: &Self::State, seat: usize, level: Level) -> Option<Self::Action> {
        let _ = (state, seat, level);
        None
    }

    /// Turns a state of layout `from_version` into one of layout `from_version + 1`.
    /// Called for each version a stored game is behind, oldest first, so every version
    /// only has to know about its successor. Works on raw JSON because the old layout
    /// no longer has a type.
    fn upgrade(from_version: u32, state: Value) -> Result<Value, StateError> {
        let _ = state;
        Err(StateError::new(format!(
            "{} has no upgrade from state version {from_version}",
            Self::KIND
        )))
    }
}

/// The state of a game that is being played, in the game's own type but with the type
/// erased so that the room system can hold games of different kinds. Never changes: a
/// move produces the next one, so a room can drop it if saving fails.
pub trait Live: Send {
    /// The game after `seat` plays `action`. Reads only the action from JSON. A malformed
    /// action is rejected like one against the rules.
    fn apply(&self, seat: usize, action: Value) -> Result<Box<dyn Live>, Rejection>;

    /// The game after `seat` gives up. See [`Game::forfeit`].
    fn forfeit(&self, seat: usize) -> Result<Box<dyn Live>, Rejection>;

    /// The state as JSON, to store and to send to clients.
    fn to_json(&self) -> Result<Value, StateError>;

    /// The state as JSON, to keep in the game's history. See [`Game::record`].
    fn to_record(&self) -> Result<Value, StateError>;

    /// Whether the game has ended. See [`Game::is_over`].
    fn is_over(&self) -> bool;

    /// A picture of the board as it stands. See [`Game::picture`].
    fn picture(&self) -> Option<String>;

    /// Whether the computer opponent has something to play for `seat`. See [`Game::bot_turn`].
    fn bot_turn(&self, seat: usize) -> bool;

    /// The work of playing for the computer opponent of the given level in `seat`, which is to
    /// say what [`Game::bot_action`] decides and [`Game::apply`] makes of it. It owns a copy of
    /// the state, so it can be run anywhere, and the game it gives is the one after the bot plays,
    /// or `None` if it has nothing to play. It can take a while, so run it where waiting is
    /// harmless (`tokio::task::spawn_blocking`), not on a task that serves requests.
    fn bot_job(&self, seat: usize, level: Level) -> BotJob;
}

/// A bot's move, to be worked out and made. See [`Live::bot_job`].
pub type BotJob = Box<dyn FnOnce() -> Option<Box<dyn Live>> + Send>;

struct Running<G: Game>(G::State);

impl<G: Game> Live for Running<G> {
    fn apply(&self, seat: usize, action: Value) -> Result<Box<dyn Live>, Rejection> {
        let action = serde_json::from_value::<G::Action>(action)
            .map_err(|err| Rejection::new(format!("not a valid action: {err}")))?;
        let next = G::apply(&self.0, seat, action)?;
        Ok(Box::new(Running::<G>(next)))
    }

    fn forfeit(&self, seat: usize) -> Result<Box<dyn Live>, Rejection> {
        let next = G::forfeit(&self.0, seat)?;
        Ok(Box::new(Running::<G>(next)))
    }

    fn to_json(&self) -> Result<Value, StateError> {
        serde_json::to_value(&self.0)
            .map_err(|err| StateError::new(format!("could not write a state as JSON: {err}")))
    }

    fn to_record(&self) -> Result<Value, StateError> {
        G::record(&self.0)
    }

    fn is_over(&self) -> bool {
        G::is_over(&self.0)
    }

    fn picture(&self) -> Option<String> {
        G::picture(Some(&self.0))
    }

    fn bot_turn(&self, seat: usize) -> bool {
        G::bot_turn(&self.0, seat)
    }

    fn bot_job(&self, seat: usize, level: Level) -> BotJob {
        let state = self.0.clone();
        Box::new(move || {
            let action = G::bot_action(&state, seat, level)?;
            match G::apply(&state, seat, action) {
                Ok(next) => Some(Box::new(Running::<G>(next)) as Box<dyn Live>),
                Err(rejection) => {
                    tracing::error!(
                        game = G::KIND,
                        seat,
                        reason = rejection.reason(),
                        "the bot played against the rules"
                    );
                    None
                }
            }
        })
    }
}

/// A [`Game`] with its types erased, so that the room system can hold games of different
/// kinds in one place. Every `Game` is an `Engine`.
pub trait Engine: Send + Sync {
    fn kind(&self) -> &'static str;
    /// See [`Game::NAME`].
    fn name(&self) -> &'static str;
    fn players(&self) -> usize;
    fn state_version(&self) -> u32;

    /// Whether the game has a computer opponent. See [`Game::BOT`].
    fn has_bot(&self) -> bool;

    /// A new game.
    fn start(&self) -> Box<dyn Live>;

    /// A picture of the board of a game that hasn't started. See [`Game::picture`].
    fn unstarted_picture(&self) -> Option<String>;

    /// Reads a stored state, first upgrading it to the current version. Fails if the
    /// game can't read it, so that a bad row fails when it is loaded, not on somebody's move.
    fn load(&self, stored_version: u32, state: Value) -> Result<Box<dyn Live>, StateError>;

    /// A record of the current layout as a client reads it in the game's history. See
    /// [`Game::history_view`].
    fn history_view(&self, record: Value) -> Result<Value, StateError>;
}

struct Typed<G>(PhantomData<fn() -> G>);

impl<G: Game> Engine for Typed<G> {
    fn kind(&self) -> &'static str {
        G::KIND
    }

    fn name(&self) -> &'static str {
        G::NAME
    }

    fn players(&self) -> usize {
        G::PLAYERS
    }

    fn state_version(&self) -> u32 {
        G::STATE_VERSION
    }

    fn has_bot(&self) -> bool {
        G::BOT
    }

    fn start(&self) -> Box<dyn Live> {
        Box::new(Running::<G>(G::start()))
    }

    fn unstarted_picture(&self) -> Option<String> {
        G::picture(None)
    }

    fn load(&self, stored_version: u32, mut state: Value) -> Result<Box<dyn Live>, StateError> {
        if stored_version > G::STATE_VERSION {
            return Err(StateError::new(format!(
                "state version {stored_version} is newer than the {} this server knows",
                G::STATE_VERSION
            )));
        }
        for version in stored_version..G::STATE_VERSION {
            state = G::upgrade(version, state)?;
        }
        let state = serde_json::from_value::<G::State>(state)
            .map_err(|err| StateError::new(format!("state does not fit the game: {err}")))?;
        Ok(Box::new(Running::<G>(state)))
    }

    fn history_view(&self, record: Value) -> Result<Value, StateError> {
        G::history_view(record)
    }
}

/// The games a server offers, by kind.
#[derive(Clone, Default)]
pub struct Games(HashMap<&'static str, Arc<dyn Engine>>);

impl Games {
    /// Adds a game. Panics if its constants are unusable or its kind is taken, because
    /// those are mistakes in the code, found when the server starts.
    pub fn with<G: Game>(mut self) -> Self {
        assert!(G::PLAYERS >= 1, "{} needs at least one player", G::KIND);
        assert!(
            (1..=i32::MAX as u32).contains(&G::STATE_VERSION),
            "{} has a state version outside 1..={}",
            G::KIND,
            i32::MAX
        );
        assert!(
            !G::BOT || G::PLAYERS == 2,
            "{} has a bot, which fills the seat of the one opponent, so it needs two players",
            G::KIND
        );
        let taken = self.0.insert(G::KIND, Arc::new(Typed::<G>(PhantomData)));
        assert!(
            taken.is_none(),
            "game kind {:?} is registered twice",
            G::KIND
        );
        self
    }

    pub fn get(&self, kind: &str) -> Option<&Arc<dyn Engine>> {
        self.0.get(kind)
    }
}

/// The games this server offers. Register new ones here.
pub fn registry() -> Games {
    Games::default()
        .with::<LongBackgammon>()
        .with::<UltimateTicTacToe>()
        .with::<Hex>()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde::{Deserialize, Deserializer};
    use serde_json::json;

    use super::*;
    use crate::test_util::{Tally, TallyV2};

    fn engine<G: Game>() -> Arc<dyn Engine> {
        Games::default().with::<G>().get(G::KIND).unwrap().clone()
    }

    fn loaded<G: Game>(state: Value) -> Box<dyn Live> {
        engine::<G>().load(1, state).expect("the state loads")
    }

    fn add(amount: i64) -> Value {
        json!({ "type": "add", "amount": amount })
    }

    #[test]
    fn a_current_state_loads_unchanged() {
        let state = json!({ "total": 3, "turn": 1 });

        let live = engine::<Tally>().load(1, state.clone()).unwrap();

        assert_eq!(live.to_json(), Ok(state));
    }

    #[test]
    fn an_old_state_is_upgraded_to_the_current_layout() {
        let live = engine::<TallyV2>()
            .load(1, json!({ "total": 3, "turn": 1 }))
            .ok()
            .unwrap();

        assert_eq!(live.to_json(), Ok(json!({ "sum": 3, "turn": 1 })));
    }

    #[test]
    fn a_state_from_a_newer_version_is_refused() {
        let loaded = engine::<Tally>().load(2, json!({ "sum": 3, "turn": 1 }));

        assert!(loaded.is_err());
    }

    #[test]
    fn a_state_with_no_upgrade_path_is_refused() {
        // `Tally` never defined an upgrade, and version 0 never existed.
        assert!(engine::<Tally>().load(0, json!({})).is_err());
    }

    #[test]
    fn a_state_that_does_not_fit_the_game_is_refused_at_load() {
        let loaded = engine::<Tally>().load(1, json!({ "total": "lots" }));

        assert!(loaded.is_err());
    }

    #[test]
    fn a_new_game_starts_in_the_games_initial_state() {
        let live = engine::<Tally>().start();

        assert_eq!(live.to_json(), Ok(json!({ "total": 0, "turn": 0 })));
    }

    #[test]
    fn apply_returns_the_next_game_and_leaves_the_old_one_alone() {
        let before = loaded::<Tally>(json!({ "total": 1, "turn": 0 }));

        let after = before.apply(0, add(4)).unwrap();

        assert_eq!(after.to_json(), Ok(json!({ "total": 5, "turn": 1 })));
        assert_eq!(before.to_json(), Ok(json!({ "total": 1, "turn": 0 })));
    }

    #[test]
    fn apply_passes_on_the_rules_reason_for_a_rejection() {
        let live = loaded::<Tally>(json!({ "total": 1, "turn": 0 }));

        let error = live.apply(1, add(4)).err();

        assert_eq!(error, Some(Rejection::new("not your turn")));
    }

    #[test]
    fn apply_rejects_an_action_of_the_wrong_shape() {
        let live = loaded::<Tally>(json!({ "total": 1, "turn": 0 }));

        let error = live.apply(0, json!({ "type": "multiply" })).err();

        let reason = error.expect("the action is rejected");
        assert!(
            reason.reason().starts_with("not a valid action"),
            "{reason:?}"
        );
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn a_kind_can_be_registered_only_once() {
        Games::default().with::<Tally>().with::<Tally>();
    }

    // A game whose state counts how many times it was read from JSON.
    static READS: AtomicUsize = AtomicUsize::new(0);

    struct Counted;

    #[derive(Clone, Serialize)]
    struct CountedState(u32);

    impl<'de> Deserialize<'de> for CountedState {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            READS.fetch_add(1, Ordering::SeqCst);
            u32::deserialize(deserializer).map(Self)
        }
    }

    impl Game for Counted {
        const KIND: &'static str = "counted";
        const NAME: &'static str = "Counted";
        const PLAYERS: usize = 1;
        const STATE_VERSION: u32 = 1;
        type State = CountedState;
        type Action = Value;

        fn start() -> CountedState {
            CountedState(0)
        }

        fn apply(state: &CountedState, _: usize, _: Value) -> Result<CountedState, Rejection> {
            Ok(CountedState(state.0 + 1))
        }
    }

    #[test]
    fn the_state_is_read_from_json_once_however_many_actions_follow() {
        let mut live = loaded::<Counted>(json!(0));
        for _ in 0..3 {
            live = live.apply(0, json!(null)).unwrap();
        }

        assert_eq!(live.to_json(), Ok(json!(3)));
        assert_eq!(READS.load(Ordering::SeqCst), 1);
    }
}
