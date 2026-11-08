//! What a game must provide to be played in a room, and the registry of the games
//! the server offers.
//!
//! A game is a pure rules engine: it knows its state, how to start one and how an
//! action by a player changes it. It knows nothing about sockets, users or the
//! database. A room keeps a game's state in memory as the game's own type. The state
//! becomes JSON only at the edges: when it is stored, sent to clients, or read back
//! from storage. An action is read from JSON, because that is how it arrives.
//!
//! To add a game, implement [`Game`] and register it in [`registry`].

// Nothing registers a game yet, so outside the tests none of this is used. Once the first game
// is in `registry`, the compiler flags this attribute as unfulfilled: delete it then.
#![cfg_attr(not(test), expect(dead_code, reason = "no game is registered yet"))]

use std::{collections::HashMap, fmt, marker::PhantomData, sync::Arc};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

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

    /// How many players a game has. Each takes a seat, numbered from 0 in the order they
    /// join, and the game starts when the last seat is taken.
    const PLAYERS: usize;

    /// The version of the JSON layout of [`Game::State`], starting at 1. Stored games
    /// keep the version they were written with. When a change to `State` means old rows
    /// no longer deserialize into it, bump this and make [`Game::upgrade`] handle the
    /// version you moved away from.
    const STATE_VERSION: u32;

    /// What a room keeps in memory for a game that is being played.
    type State: Serialize + DeserializeOwned + Send + 'static;
    type Action: DeserializeOwned;

    /// The state of a new game, once all the seats are taken.
    fn start() -> Self::State;

    /// The state after `seat` plays `action`, or why it can't. This must not need
    /// anything but its arguments to decide, apart from randomness such as dice.
    /// An accepted action is a new revision of the game even if it changed nothing.
    fn apply(
        state: &Self::State,
        seat: usize,
        action: Self::Action,
    ) -> Result<Self::State, Rejection>;

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

    /// The state as JSON, to store and to send to clients.
    fn to_json(&self) -> Result<Value, StateError>;
}

struct Running<G: Game>(G::State);

impl<G: Game> Live for Running<G> {
    fn apply(&self, seat: usize, action: Value) -> Result<Box<dyn Live>, Rejection> {
        let action = serde_json::from_value::<G::Action>(action)
            .map_err(|err| Rejection::new(format!("not a valid action: {err}")))?;
        let next = G::apply(&self.0, seat, action)?;
        Ok(Box::new(Running::<G>(next)))
    }

    fn to_json(&self) -> Result<Value, StateError> {
        serde_json::to_value(&self.0)
            .map_err(|err| StateError::new(format!("could not write a state as JSON: {err}")))
    }
}

/// A [`Game`] with its types erased, so that the room system can hold games of different
/// kinds in one place. Every `Game` is an `Engine`.
pub trait Engine: Send + Sync {
    fn kind(&self) -> &'static str;
    fn players(&self) -> usize;
    fn state_version(&self) -> u32;

    /// A new game.
    fn start(&self) -> Box<dyn Live>;

    /// Reads a stored state, first upgrading it to the current version. Fails if the
    /// game can't read it, so that a bad row fails when it is loaded, not on somebody's move.
    fn load(&self, stored_version: u32, state: Value) -> Result<Box<dyn Live>, StateError>;
}

struct Typed<G>(PhantomData<fn() -> G>);

impl<G: Game> Engine for Typed<G> {
    fn kind(&self) -> &'static str {
        G::KIND
    }

    fn players(&self) -> usize {
        G::PLAYERS
    }

    fn state_version(&self) -> u32 {
        G::STATE_VERSION
    }

    fn start(&self) -> Box<dyn Live> {
        Box::new(Running::<G>(G::start()))
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

/// The games this server offers. Register new ones here, e.g. `.with::<LongBackgammon>()`.
pub fn registry() -> Games {
    Games::default()
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

    #[derive(Serialize)]
    struct CountedState(u32);

    impl<'de> Deserialize<'de> for CountedState {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            READS.fetch_add(1, Ordering::SeqCst);
            u32::deserialize(deserializer).map(Self)
        }
    }

    impl Game for Counted {
        const KIND: &'static str = "counted";
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
