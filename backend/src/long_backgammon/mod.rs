//! Long backgammon (long nardy) as a [`Game`]. The rules are in
//! `docs/games/long-backgammon.md`; follow them exactly, and ask before deviating.
//!
//! [`rules`] says what one die may do and which steps a player may start with. This module
//! is the game around it: whose turn it is, rolling, the turn passing when nothing can be
//! played, the last throw, and the score.
//!
//! # The state
//!
//! The state is addressed by **seat**, the player's place in the room (0 is whoever created
//! the game). Colours follow the rules: White is the player who moves first, picked at random
//! when the game starts, and is `white` in the state. All of a player's checkers are in their
//! **own index**: `points[seat][i - 1]` is the number of that player's checkers on their own
//! point `i`, where 1 is the head and 19 to 24 the home. A physical point is `i` to one
//! player and `i + 12` (or `i - 12`) to the other. See [`rules::across`].
//!
//! A turn is played one step at a time, so that the other player (and anyone watching) sees
//! it happen. A step is one die played by one checker. The state tells the client which steps
//! are legal, so that clients don't need to know the rules. In JSON (camelCase):
//!
//! ```json
//! { "white": 0,
//!   "points": [[15, 0, …, 0], [15, 0, …, 0]], "off": [0, 0],
//!   "turn": 0, "turns": [0, 0], "lastThrow": false,
//!   "phase": { "type": "roll" },
//!   "legal": [], "combos": [],
//!   "lastTurn": null }
//! ```
//!
//! `phase` is one of
//!
//! - `{ "type": "roll" }`: `turn` must roll.
//! - `{ "type": "move", "dice": [a, b], "remaining": […], "played": [step, …] }`: `turn`
//!   rolled `dice`, and `remaining` are the dice still to play (four for a double). `played`
//!   are this turn's steps so far.
//! - `{ "type": "over", "winner": 0, "points": 1, "forfeited": false }`: the game is over.
//!   `winner` is a seat, or null for a draw. `points` are what it scored: 1 (oyn), 2 (mars), or
//!   0 for a draw. `forfeited` is true when the other player gave up (D10), which always scores
//!   1 point for `winner`; states stored before forfeits existed have no `forfeited`, meaning
//!   false.
//!
//! A step is `{ "from": 3, "die": 5 }`: the checker on own point `from` moves `die` points,
//! to `from + die`, or off the board from 25 on. `legal` lists exactly the steps `turn` may
//! play now, with the must-play rules applied. It is empty unless the phase is `move`, and
//! is worked out again whenever a state is read, so it never needs an upgrade.
//!
//! `combos` lists the ways to play two or more dice with one checker in a row, so that a
//! client can offer them as a single move: each is a list of steps (`[{ "from": 1, "die": 2 },
//! { "from": 3, "die": 5 }]`), each starting where the one before landed. It adds no rule.
//! Every step of a combo is one of `legal` in the position the steps before it lead to, and
//! the client plays them as separate `move` actions, so the other player still sees each
//! step. A combo of a double has a line for each length, from two to four steps. Like
//! `legal`, it is derived, empty unless the phase is `move`, and worked out again when read.
//!
//! A turn ends by itself when it has no legal step left. That includes the moment of the roll,
//! when nothing can be played. `lastTurn` then says what the turn that just ended was (empty
//! `played` for a lost turn). `lastThrow` is set once White has borne off everything: Black
//! gets one last turn.
//!
//! # Actions
//!
//! `{ "type": "roll" }` rolls the dice for the player to move, and
//! `{ "type": "move", "from": 3, "die": 5 }` plays a step. `{ "type": "undo" }` takes back
//! the last step of the turn in progress and gives its die back (D7). There is no action for
//! passing. Giving up is not an action either: a player sends the socket's own `forfeit`
//! message (D10), which is allowed on either turn.

mod bot;
mod picture;
mod rules;

use serde::{Deserialize, Serialize};

use crate::{
    bot::{Level, System},
    game::{Game, Rejection, StateError},
};
use rules::{CHECKERS, Points, Step, Turn};

/// The game itself. It has no data: everything is in its [`State`].
pub struct LongBackgammon;

/// What a player may send.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    Roll,
    Move {
        from: u8,
        die: u8,
    },
    /// Takes back the last step of the turn in progress.
    Undo,
}

/// Where a turn stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Phase {
    /// The player to move must roll.
    Roll,
    Move {
        dice: [u8; 2],
        /// The dice still to play.
        remaining: Vec<u8>,
        /// The steps played so far this turn.
        played: Vec<Step>,
    },
    Over {
        /// A seat, or none for a draw.
        winner: Option<usize>,
        points: u8,
        /// The loser gave up (D10): `winner` is the other seat and `points` is
        /// [`FORFEIT_POINTS`], whatever the board looks like. Games stored before forfeits
        /// existed don't have it, and were not forfeited.
        #[serde(default)]
        forfeited: bool,
    },
}

/// What a forfeit scores for the winner, whatever the loser has borne off (D10).
const FORFEIT_POINTS: u8 = 1;

/// A turn that has ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct LastTurn {
    seat: usize,
    dice: [u8; 2],
    played: Vec<Step>,
}

/// The game as it stands, apart from what can be worked out from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Position {
    /// The seat that moves first.
    white: usize,
    /// By seat, in the owner's own index.
    points: [Points; 2],
    /// Checkers borne off, by seat.
    off: [u8; 2],
    /// The seat to move; after the game, the seat that moved last.
    turn: usize,
    /// How many turns each seat has completed.
    turns: [u32; 2],
    /// White has borne off everything, and Black is playing the last throw.
    last_throw: bool,
    phase: Phase,
    last_turn: Option<LastTurn>,
}

/// A [`Position`] with the steps that are legal in it. This is what is stored and sent.
///
/// `legal` and `combos` are derived. They are written out for clients, and read back by
/// working them out again from the position, so that a stored game follows the rules of the
/// server that loads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Position")]
pub struct State {
    #[serde(flatten)]
    position: Position,
    legal: Vec<Step>,
    /// The ways to play two or more dice with one checker, one after the other (see
    /// [`rules::combos`]). Empty when `legal` is.
    combos: Vec<Vec<Step>>,
}

impl TryFrom<Position> for State {
    type Error = String;

    /// Checks that the position is one the game could be in, then works out what is legal,
    /// ending the turn if nothing is.
    fn try_from(mut position: Position) -> Result<Self, String> {
        position.validate()?;
        // Empty outside a turn in progress, and when no step is left.
        let legal = position.legal();
        if legal.is_empty() {
            position.end_turn(); // Does nothing unless a turn is in progress.
            return Ok(Self {
                position,
                legal,
                combos: Vec::new(),
            });
        }
        let combos = position.combos();
        Ok(Self {
            position,
            legal,
            combos,
        })
    }
}

impl State {
    /// A position that the rules reached. Panics only if it is not one, which would be a
    /// bug in this module.
    fn reached(position: Position) -> Self {
        Self::try_from(position).expect("the rules only reach valid positions")
    }

    /// The state after `seat` plays `action`, or why they can't. `dice` rolls the dice when
    /// the action needs them, and is not called otherwise.
    fn act(
        &self,
        seat: usize,
        action: Action,
        dice: impl FnOnce() -> Option<[u8; 2]>,
    ) -> Result<State, Rejection> {
        let position = &self.position;
        match (&position.phase, action) {
            (Phase::Over { .. }, _) => Err(Rejection::new("the game is over")),
            _ if seat != position.turn => Err(Rejection::new("not your turn")),
            (Phase::Roll, Action::Roll) => {
                let dice = dice().ok_or_else(|| Rejection::new("the dice could not be rolled"))?;
                Ok(Self::reached(position.rolled(dice)))
            }
            (Phase::Move { .. }, Action::Roll) => Err(Rejection::new("you have already rolled")),
            (Phase::Roll, Action::Move { .. }) => Err(Rejection::new("roll the dice first")),
            (Phase::Roll, Action::Undo) => Err(Rejection::new("you have not played anything yet")),
            (Phase::Move { .. }, Action::Undo) => position
                .unplayed()
                .map(Self::reached)
                .ok_or_else(|| Rejection::new("you have not played anything yet")),
            (
                Phase::Move {
                    dice,
                    remaining,
                    played,
                },
                Action::Move { from, die },
            ) => {
                let step = Step { from, die };
                let Some(which) = remaining.iter().position(|&left| left == die) else {
                    return Err(Rejection::new(format!("you have no {die} to play")));
                };
                let turn = position.turn_view(*dice, played);
                if !self.legal.contains(&step) {
                    return Err(Rejection::new(match rules::check(&turn, step) {
                        Err(illegal) => illegal.message(step),
                        // Allowed on its own, so it is the must-play rules that forbid it.
                        Ok(_) => "you must play as many dice as you can, and the larger die \
                                  if you can play only one"
                            .to_owned(),
                    }));
                }
                let next = rules::play(&turn, step)
                    .map_err(|illegal| Rejection::new(illegal.message(step)))?;

                let mut position = position.clone();
                position.points[position.turn] = next.mine;
                position.off[position.turn] = next.off;
                let mut remaining = remaining.clone();
                remaining.remove(which);
                let mut played = played.clone();
                played.push(step);
                position.phase = Phase::Move {
                    dice: *dice,
                    remaining,
                    played,
                };
                Ok(Self::reached(position))
            }
        }
    }
}

impl State {
    /// The state after `seat` gives up (D10): the other seat wins [`FORFEIT_POINTS`]. Not a
    /// move, so it is allowed on either turn and in the middle of one. A game that is over
    /// can't be given up.
    fn forfeit(&self, seat: usize) -> Result<State, Rejection> {
        if seat >= 2 {
            return Err(Rejection::new("there is no such seat"));
        }
        if matches!(self.position.phase, Phase::Over { .. }) {
            return Err(Rejection::new("the game is over"));
        }
        let mut position = self.position.clone();
        position.phase = Phase::Over {
            winner: Some(1 - seat),
            points: FORFEIT_POINTS,
            forfeited: true,
        };
        Ok(Self::reached(position))
    }
}

impl Position {
    /// A new game: all of both players' checkers on their heads, and White to roll.
    fn new(white: usize) -> Self {
        let mut head = [0; 24];
        head[0] = CHECKERS;
        Self {
            white,
            points: [head, head],
            off: [0, 0],
            turn: white,
            turns: [0, 0],
            last_throw: false,
            phase: Phase::Roll,
            last_turn: None,
        }
    }

    /// Rejects a position that no game could be in, so that the rest of the module can
    /// index by seat and trust the dice.
    fn validate(&self) -> Result<(), String> {
        let seat = |seat: usize| (seat < 2).then_some(()).ok_or("a seat is not 0 or 1");
        seat(self.white)?;
        seat(self.turn)?;
        if let Some(last) = &self.last_turn {
            seat(last.seat)?;
        }
        for who in 0..2 {
            let on_board: u32 = self.points[who].iter().map(|&n| u32::from(n)).sum();
            if on_board + u32::from(self.off[who]) != u32::from(CHECKERS) {
                return Err(format!("seat {who} does not have {CHECKERS} checkers"));
            }
        }
        let die = |die: &u8| (1..=6).contains(die);
        match &self.phase {
            Phase::Move {
                dice, remaining, ..
            } => {
                if !dice.iter().all(die) || !remaining.iter().all(die) || remaining.len() > 4 {
                    return Err("the dice are not dice".to_owned());
                }
            }
            Phase::Over {
                winner, forfeited, ..
            } => {
                if let Some(winner) = winner {
                    seat(*winner)?;
                }
                if *forfeited && winner.is_none() {
                    return Err("a forfeited game has a winner".to_owned());
                }
            }
            Phase::Roll => {}
        }
        Ok(())
    }

    /// The position as the player to move sees it.
    fn turn_view(&self, dice: [u8; 2], played: &[Step]) -> Turn {
        let me = self.turn;
        // Each player's own first turn may take two checkers off the head on 3-3, 4-4, 6-6.
        let first_turn_double =
            self.turns[me] == 0 && dice[0] == dice[1] && matches!(dice[0], 3 | 4 | 6);
        let allowed = if first_turn_double { 2 } else { 1 };
        let used = played.iter().filter(|step| step.from == 1).count();
        Turn {
            mine: self.points[me],
            off: self.off[me],
            theirs: self.points[1 - me],
            head_left: (allowed - used.min(allowed)) as u8,
        }
    }

    /// The legal steps, if the player to move has dice to play.
    fn legal(&self) -> Vec<Step> {
        match &self.phase {
            Phase::Move {
                dice,
                remaining,
                played,
            } => rules::legal_steps(&self.turn_view(*dice, played), remaining),
            Phase::Roll | Phase::Over { .. } => Vec::new(),
        }
    }

    /// The ways to play two or more of the dice left with one checker, if the player to move
    /// has dice to play.
    fn combos(&self) -> Vec<Vec<Step>> {
        match &self.phase {
            Phase::Move {
                dice,
                remaining,
                played,
            } => rules::combos(&self.turn_view(*dice, played), remaining),
            Phase::Roll | Phase::Over { .. } => Vec::new(),
        }
    }

    /// The position after the player to move rolls `dice`.
    fn rolled(&self, dice: [u8; 2]) -> Self {
        let remaining = if dice[0] == dice[1] {
            vec![dice[0]; 4]
        } else {
            dice.to_vec()
        };
        Self {
            phase: Phase::Move {
                dice,
                remaining,
                played: Vec::new(),
            },
            ..self.clone()
        }
    }

    /// The position with the last step of the turn in progress taken back (D7): its checker is
    /// where it was and its die is back among the dice to play. `None` if no step has been
    /// played, or the step does not fit the position (a stored game that was edited), in
    /// which case there is nothing sound to go back to.
    ///
    /// A turn ends as soon as it has nothing left to play, so the step that ends it is never
    /// here to take back: by then the phase is no longer a move.
    fn unplayed(&self) -> Option<Self> {
        let Phase::Move { dice, played, .. } = &self.phase else {
            return None;
        };
        let (last, earlier) = played.split_last()?;
        let me = self.turn;
        let mut position = self.clone();

        if !(1..=24).contains(&last.from) {
            return None;
        }
        position.points[me][usize::from(last.from) - 1] += 1;
        let to = u16::from(last.from) + u16::from(last.die);
        if to <= 24 {
            let landed = &mut position.points[me][usize::from(to) - 1];
            *landed = landed.checked_sub(1)?;
        } else {
            position.off[me] = position.off[me].checked_sub(1)?;
        }

        // The dice that are left are the roll without the ones played before this step.
        let mut remaining = if dice[0] == dice[1] {
            vec![dice[0]; 4]
        } else {
            dice.to_vec()
        };
        for step in earlier {
            let at = remaining.iter().position(|&left| left == step.die)?;
            remaining.remove(at);
        }
        position.phase = Phase::Move {
            dice: *dice,
            remaining,
            played: earlier.to_vec(),
        };
        Some(position)
    }

    /// Finishes the turn in progress, and decides what comes next: the other player's roll,
    /// the last throw, or the end of the game.
    fn end_turn(&mut self) {
        let Phase::Move { dice, played, .. } = self.phase.clone() else {
            return; // No turn in progress, and a finished game stays finished.
        };
        self.phase = Phase::Roll;
        let mover = self.turn;
        let other = 1 - mover;
        self.last_turn = Some(LastTurn {
            seat: mover,
            dice,
            played,
        });
        self.turns[mover] += 1;

        let finished = self.off[mover] == CHECKERS;
        // `Some(winner)` ends the game; a draw is `Some(None)`.
        let result = if self.last_throw {
            // The mover is Black, with the last throw. Bearing off everything draws.
            Some(if finished { None } else { Some(other) })
        } else if finished && mover == self.white {
            self.last_throw = true;
            None
        } else if finished {
            Some(Some(mover))
        } else {
            None
        };
        match result {
            Some(winner) => {
                // Mars: the loser has borne off nothing. Judged now, after any last throw.
                let points =
                    winner.map_or(0, |winner| if self.off[1 - winner] == 0 { 2 } else { 1 });
                self.phase = Phase::Over {
                    winner,
                    points,
                    forfeited: false,
                };
            }
            None => self.turn = other,
        }
    }
}

impl Game for LongBackgammon {
    const KIND: &'static str = "long-backgammon";
    const NAME: &'static str = "Long backgammon";
    const PLAYERS: usize = 2;
    const STATE_VERSION: u32 = 1;
    const BOT: bool = true;
    type State = State;
    type Action = Action;

    fn is_over(state: &State) -> bool {
        matches!(state.position.phase, Phase::Over { .. })
    }

    fn picture(state: Option<&State>) -> Option<String> {
        Some(picture::picture(state))
    }

    /// The position alone. `legal` and `combos` are worked out again from it when a state is
    /// read (see [`State`]), and for a game of some hundreds of states they would be most of
    /// what the history stores.
    fn record(state: &State) -> Result<serde_json::Value, StateError> {
        serde_json::to_value(&state.position)
            .map_err(|err| StateError::new(format!("could not write a state as JSON: {err}")))
    }

    /// Picks White at random: the rules let an implementation do that instead of having
    /// the players roll a die each.
    fn start() -> State {
        let white = random_bytes::<1>().expect("the system's random source works")[0] & 1;
        State::reached(Position::new(usize::from(white)))
    }

    fn apply(state: &State, seat: usize, action: Action) -> Result<State, Rejection> {
        state.act(seat, action, || roll().ok())
    }

    fn forfeit(state: &State, seat: usize) -> Result<State, Rejection> {
        state.forfeit(seat)
    }

    fn bot_turn(state: &State, seat: usize) -> bool {
        bot::to_move(state, seat)
    }

    fn bot_action(state: &State, seat: usize, level: Level) -> Option<Action> {
        bot::action(state, seat, level, &mut System)
    }
}

fn random_bytes<const N: usize>() -> Result<[u8; N], getrandom::Error> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes)?;
    Ok(bytes)
}

/// One fair die. A byte has 256 values, which 6 doesn't divide, so the last four are skipped.
fn roll_die() -> Result<u8, getrandom::Error> {
    loop {
        let [byte] = random_bytes()?;
        if byte < 252 {
            return Ok(byte % 6 + 1);
        }
    }
}

fn roll() -> Result<[u8; 2], getrandom::Error> {
    Ok([roll_die()?, roll_die()?])
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::rules::tests::points;
    use super::*;

    /// A position with the players' checkers as given: `(point, count)` pairs for each
    /// seat, and borne-off counts. White is seat 0 and to roll. The checkers a seat has
    /// left over (to make 15) are put on a point that doesn't matter to the test.
    fn position(mine: &[(u8, u8)], theirs: &[(u8, u8)], off: [u8; 2]) -> Position {
        Position {
            points: [points(mine), points(theirs)],
            off,
            turns: [1, 1],
            ..Position::new(0)
        }
    }

    fn state(position: Position) -> State {
        State::reached(position)
    }

    fn rolled(state: &State, seat: usize, dice: [u8; 2]) -> State {
        state
            .act(seat, Action::Roll, || Some(dice))
            .expect("the roll is accepted")
    }

    fn step(from: u8, die: u8) -> Step {
        Step { from, die }
    }

    fn play(state: &State, seat: usize, from: u8, die: u8) -> Result<State, Rejection> {
        state.act(seat, Action::Move { from, die }, || None)
    }

    fn reason(result: Result<State, Rejection>) -> String {
        result.expect_err("rejected").reason().to_owned()
    }

    fn fresh(white: usize) -> State {
        state(Position::new(white))
    }

    // --- Being over ---

    #[test]
    fn the_game_reports_when_it_is_over_so_that_the_server_can_list_it_as_finished() {
        let mut position = Position::new(0);
        assert!(!LongBackgammon::is_over(&state(position.clone())));
        position.phase = Phase::Move {
            dice: [5, 2],
            remaining: vec![5, 2],
            played: Vec::new(),
        };
        assert!(!LongBackgammon::is_over(&state(position.clone())));

        position.phase = Phase::Over {
            winner: Some(0),
            points: 1,
            forfeited: false,
        };
        assert!(LongBackgammon::is_over(&state(position)));
    }

    #[test]
    fn a_game_is_over_when_black_bears_off_the_last_checker() {
        // Black is seat 1. With a 1 and a 2 and one checker, the larger die is the one to play.
        let mut near = position(&[(1, 15)], &[(24, 1)], [0, 14]);
        near.turn = 1;
        near.turns = [9, 9];
        let game = rolled(&state(near), 1, [1, 2]);
        assert!(!LongBackgammon::is_over(&game));

        let game = play(&game, 1, 24, 2).unwrap();

        assert!(LongBackgammon::is_over(&game));
        assert!(matches!(game.position.phase, Phase::Over { .. }));
    }

    #[test]
    fn a_game_is_not_over_when_white_bears_off_the_last_checker_because_black_throws_once_more() {
        let mut near = position(&[(24, 1)], &[(1, 15)], [14, 0]);
        near.turns = [9, 9];
        let game = rolled(&state(near), 0, [1, 2]);

        let game = play(&game, 0, 24, 2).unwrap();

        assert!(game.position.last_throw);
        assert!(!LongBackgammon::is_over(&game));
    }

    // --- Starting ---

    #[test]
    fn a_new_game_has_every_checker_on_its_players_head_and_white_to_roll() {
        for white in [0, 1] {
            let game = fresh(white);

            assert_eq!(game.position.turn, white);
            assert_eq!(game.position.points, [points(&[(1, 15)]); 2]);
            assert_eq!(game.position.phase, Phase::Roll);
            assert_eq!(game.legal, Vec::new());
        }
    }

    #[test]
    fn the_starter_is_picked_at_random() {
        let starters: Vec<usize> = (0..64)
            .map(|_| LongBackgammon::start().position.white)
            .collect();

        assert!(
            starters.contains(&0) && starters.contains(&1),
            "{starters:?}"
        );
    }

    #[test]
    fn dice_are_fair_looking_dice() {
        let mut seen = [0u32; 7];
        for _ in 0..3000 {
            let [a, b] = roll().unwrap();
            seen[usize::from(a)] += 1;
            seen[usize::from(b)] += 1;
        }

        assert_eq!(seen[0], 0);
        // 6000 dice: about 1000 of each. Far from that would be a broken generator.
        assert!(
            seen[1..].iter().all(|&n| (800..1200).contains(&n)),
            "{seen:?}"
        );
    }

    // --- Turn flow ---

    #[test]
    fn only_the_player_to_move_may_act() {
        let game = fresh(0);

        assert_eq!(
            reason(game.act(1, Action::Roll, || Some([1, 2]))),
            "not your turn"
        );
        assert_eq!(reason(play(&game, 1, 1, 1)), "not your turn");
        assert_eq!(
            reason(game.act(7, Action::Roll, || Some([1, 2]))),
            "not your turn"
        );
    }

    #[test]
    fn a_move_needs_the_dice_to_be_rolled_first() {
        assert_eq!(reason(play(&fresh(0), 0, 1, 3)), "roll the dice first");
    }

    #[test]
    fn the_dice_can_be_rolled_once() {
        let game = rolled(&fresh(0), 0, [5, 2]);

        assert_eq!(
            reason(game.act(0, Action::Roll, || Some([1, 1]))),
            "you have already rolled"
        );
    }

    #[test]
    fn a_roll_that_cannot_be_made_is_refused_and_changes_nothing() {
        let game = fresh(0);

        assert_eq!(
            reason(game.act(0, Action::Roll, || None)),
            "the dice could not be rolled"
        );
        assert_eq!(game.position.phase, Phase::Roll);
    }

    #[test]
    fn a_roll_gives_the_dice_and_what_may_be_played() {
        let game = rolled(&fresh(0), 0, [5, 2]);

        assert_eq!(
            game.position.phase,
            Phase::Move {
                dice: [5, 2],
                remaining: vec![5, 2],
                played: vec![]
            }
        );
        assert_eq!(game.legal, vec![step(1, 2), step(1, 5)]);
    }

    #[test]
    fn a_double_gives_four_moves() {
        let game = rolled(&fresh(0), 0, [2, 2]);

        assert_eq!(
            game.position.phase,
            Phase::Move {
                dice: [2, 2],
                remaining: vec![2; 4],
                played: vec![]
            }
        );
    }

    #[test]
    fn playing_a_step_moves_the_checker_and_uses_up_the_die() {
        let game = rolled(&fresh(0), 0, [5, 2]);

        let game = play(&game, 0, 1, 5).unwrap();

        assert_eq!(game.position.points[0], points(&[(1, 14), (6, 1)]));
        assert_eq!(
            game.position.phase,
            Phase::Move {
                dice: [5, 2],
                remaining: vec![2],
                played: vec![step(1, 5)]
            }
        );
        // The head is used up, so the 2 can only be played from 6.
        assert_eq!(game.legal, vec![step(6, 2)]);
    }

    #[test]
    fn the_turn_passes_when_the_last_die_is_played() {
        let game = rolled(&fresh(0), 0, [5, 2]);
        let game = play(&game, 0, 1, 5).unwrap();

        let game = play(&game, 0, 6, 2).unwrap();

        assert_eq!(game.position.turn, 1);
        assert_eq!(game.position.phase, Phase::Roll);
        assert_eq!(game.position.turns, [1, 0]);
        assert_eq!(
            game.position.last_turn,
            Some(LastTurn {
                seat: 0,
                dice: [5, 2],
                played: vec![step(1, 5), step(6, 2)]
            })
        );
        assert_eq!(game.legal, Vec::new());
    }

    #[test]
    fn a_die_that_is_not_in_the_roll_is_refused() {
        let game = rolled(&fresh(0), 0, [5, 2]);

        assert_eq!(reason(play(&game, 0, 1, 3)), "you have no 3 to play");
    }

    #[test]
    fn a_step_against_the_rules_is_refused_with_the_reason() {
        let game = rolled(&fresh(1), 1, [5, 2]);
        let game = play(&game, 1, 1, 5).unwrap();
        let game = play(&game, 1, 6, 2).unwrap();
        let game = rolled(&game, 0, [6, 6]);

        assert_eq!(
            reason(play(&game, 0, 2, 6)),
            "you have no checker on point 2"
        );
        assert_eq!(
            reason(play(&game, 0, 0, 6)),
            "you have no checker on point 0"
        );
    }

    #[test]
    fn a_step_that_is_blocked_names_the_point() {
        // Seat 0 on 10, seat 1 on its head (own 13 is its point 1).
        let game = state(position(&[(10, 15)], &[(1, 15)], [0, 0]));
        let game = rolled(&game, 0, [3, 6]);

        assert_eq!(
            reason(play(&game, 0, 10, 3)),
            "point 13 is held by your opponent"
        );
    }

    #[test]
    fn a_step_that_is_forbidden_by_the_must_play_rules_says_so() {
        // Worked example 6: only the larger die can be played, so the 1 is refused. The
        // other checkers are stuck on 24, where they can't move or bear off.
        let game = state(position(&[(10, 1), (24, 14)], &[(5, 15)], [0, 0]));
        let game = rolled(&game, 0, [6, 1]);
        assert_eq!(game.legal, vec![step(10, 6)]);

        let said = reason(play(&game, 0, 10, 1));

        assert!(
            said.starts_with("you must play as many dice as you can"),
            "{said}"
        );
    }

    // --- Undo (D7) ---

    fn undo(state: &State, seat: usize) -> Result<State, Rejection> {
        state.act(seat, Action::Undo, || None)
    }

    #[test]
    fn undo_puts_the_checker_back_and_gives_the_die_back() {
        let game = rolled(&fresh(0), 0, [5, 2]);
        let played = play(&game, 0, 1, 5).unwrap();
        assert_eq!(played.position.points[0], points(&[(1, 14), (6, 1)]));

        let back = undo(&played, 0).unwrap();

        assert_eq!(back, game);
    }

    #[test]
    fn undo_keeps_the_dice_in_the_order_they_were_rolled() {
        let game = rolled(&fresh(0), 0, [5, 2]);
        // The second die first: `remaining` is [5] now, and must come back as [5, 2].
        let game = play(&game, 0, 1, 2).unwrap();

        let back = undo(&game, 0).unwrap();

        assert_eq!(
            back.position.phase,
            Phase::Move {
                dice: [5, 2],
                remaining: vec![5, 2],
                played: Vec::new()
            }
        );
    }

    #[test]
    fn undo_takes_back_one_step_at_a_time_and_the_last_one_first() {
        let game = rolled(&fresh(0), 0, [5, 5]);
        let one = play(&game, 0, 1, 5).unwrap();
        let two = play(&one, 0, 6, 5).unwrap();
        let three = play(&two, 0, 11, 5).unwrap();

        let back_to_two = undo(&three, 0).unwrap();
        let back_to_one = undo(&back_to_two, 0).unwrap();
        let back_to_none = undo(&back_to_one, 0).unwrap();

        assert_eq!(back_to_two, two);
        assert_eq!(back_to_one, one);
        assert_eq!(back_to_none, game);
        assert_eq!(
            reason(undo(&back_to_none, 0)),
            "you have not played anything yet"
        );
    }

    #[test]
    fn a_step_can_be_played_again_after_undo_and_a_different_one_instead() {
        let game = rolled(&fresh(0), 0, [5, 2]);
        let game = play(&game, 0, 1, 5).unwrap();
        // The head is used up, so only the checker on 6 may play the 2.
        assert_eq!(game.legal, vec![step(6, 2)]);

        let game = undo(&game, 0).unwrap();

        // Undo gives the head back too, so the 2 may be played from there.
        assert!(game.legal.contains(&step(1, 2)));
        let game = play(&game, 0, 1, 2).unwrap();
        assert_eq!(game.position.points[0], points(&[(1, 14), (3, 1)]));
    }

    #[test]
    fn undo_brings_a_borne_off_checker_back() {
        let game = state(position(&[(20, 1), (22, 14)], &[(1, 15)], [0, 0]));
        let game = rolled(&game, 0, [5, 6]);
        let borne = play(&game, 0, 20, 5).unwrap();
        assert_eq!(borne.position.off, [1, 0]);
        assert_eq!(borne.position.points[0], points(&[(22, 14)]));

        let back = undo(&borne, 0).unwrap();

        assert_eq!(back, game);
    }

    #[test]
    fn undo_leaves_the_turn_counters_and_the_last_turn_alone() {
        let before = rolled(&fresh(0), 0, [5, 2]);
        let before = play(&before, 0, 1, 5).unwrap();
        let before = play(&before, 0, 6, 2).unwrap();
        let game = rolled(&before, 1, [5, 2]);
        let game = play(&game, 1, 1, 5).unwrap();

        let back = undo(&game, 1).unwrap();

        assert_eq!(back.position.turns, before.position.turns);
        assert_eq!(back.position.last_turn, before.position.last_turn);
        assert_eq!(back.position.turn, 1);
    }

    #[test]
    fn nothing_can_be_undone_before_a_step_is_played() {
        let nothing = "you have not played anything yet";

        assert_eq!(reason(undo(&fresh(0), 0)), nothing);
        assert_eq!(reason(undo(&rolled(&fresh(0), 0, [5, 2]), 0)), nothing);
    }

    #[test]
    fn only_the_player_to_move_may_undo() {
        let game = rolled(&fresh(0), 0, [5, 2]);
        let game = play(&game, 0, 1, 5).unwrap();

        assert_eq!(reason(undo(&game, 1)), "not your turn");
        assert_eq!(reason(undo(&game, 7)), "not your turn");
    }

    #[test]
    fn the_step_that_ends_the_turn_cannot_be_undone() {
        let game = rolled(&fresh(0), 0, [5, 2]);
        let game = play(&game, 0, 1, 5).unwrap();
        let game = play(&game, 0, 6, 2).unwrap();
        assert_eq!(game.position.turn, 1);

        // The turn is over: the old mover is not to move, and the new one has played nothing.
        assert_eq!(reason(undo(&game, 0)), "not your turn");
        assert_eq!(reason(undo(&game, 1)), "you have not played anything yet");
    }

    #[test]
    fn nothing_can_be_undone_once_the_game_is_over() {
        let mut over = Position::new(0);
        over.phase = Phase::Over {
            winner: Some(0),
            points: 1,
            forfeited: false,
        };

        assert_eq!(reason(undo(&state(over), 0)), "the game is over");
    }

    #[test]
    fn a_stored_step_that_does_not_fit_the_position_is_refused_not_a_panic() {
        // A checker on 10 can still play the 2, so the turn is not over when it is read.
        let midway = |played: Step| {
            let mut position = position(&[(1, 14), (10, 1)], &[(1, 15)], [0, 0]);
            position.phase = Phase::Move {
                dice: [3, 2],
                remaining: vec![2],
                played: vec![played],
            };
            state(position)
        };
        let nothing = "you have not played anything yet";

        // Nothing stands on point 4, where the step claims to have landed.
        assert_eq!(reason(undo(&midway(step(1, 3)), 0)), nothing);
        // There is no point 0.
        assert_eq!(reason(undo(&midway(step(0, 3)), 0)), nothing);
    }

    #[test]
    fn undo_is_an_action_on_the_wire() {
        let action: Action = serde_json::from_value(json!({ "type": "undo" })).unwrap();

        assert_eq!(action, Action::Undo);
    }

    // --- Head rule across turns ---

    #[test]
    fn each_players_own_first_turn_may_take_two_checkers_off_the_head_on_a_big_double() {
        // Black is seat 1. D1: both players' first turns have the exception.
        let game = rolled(&fresh(0), 0, [6, 6]);
        let game = play(&game, 0, 1, 6).unwrap();
        assert_eq!(game.legal, vec![step(1, 6)]);
        let game = play(&game, 0, 1, 6).unwrap();

        // The other sixes are lost: the checkers on 7 would land on 13, the opponent's head.
        assert_eq!(game.position.turn, 1);
        assert_eq!(game.position.points[0], points(&[(1, 13), (7, 2)]));
        assert_eq!(game.position.turns, [1, 0]);

        let game = rolled(&game, 1, [4, 4]);
        assert_eq!(game.legal, vec![step(1, 4)]);
        let game = play(&game, 1, 1, 4).unwrap();
        // Still the first turn of seat 1, with four 4s: the second head checker is allowed
        // (and needed to play four dice).
        assert!(game.legal.contains(&step(1, 4)));
    }

    #[test]
    fn the_exception_is_gone_after_the_first_turn() {
        let mut later = Position::new(0);
        later.turns = [1, 1];
        let game = rolled(&state(later), 0, [6, 6]);

        let game = play(&game, 0, 1, 6).unwrap();

        // Only the checker on 7 could play on, and it can't (13 is held), so the turn is over.
        assert_eq!(game.position.points[0], points(&[(1, 14), (7, 1)]));
        assert_eq!(game.position.turn, 1);
    }

    #[test]
    fn other_doubles_on_the_first_turn_take_one_checker_off_the_head() {
        let game = rolled(&fresh(0), 0, [5, 5]);

        let game = play(&game, 0, 1, 5).unwrap();

        // One head checker plays on alone: 6, 11, 16, 21.
        assert_eq!(game.legal, vec![step(6, 5)]);
    }

    // --- A turn with nothing to play ---

    #[test]
    fn a_player_with_no_legal_move_loses_the_turn_at_once() {
        // Own 11 to 16 are all held by the opponent (its 23, 24, 1, 2, 3, 4).
        let blocked = position(
            &[(10, 15)],
            &[(23, 1), (24, 1), (1, 1), (2, 1), (3, 1), (4, 10)],
            [0, 0],
        );
        let game = state(blocked);

        let game = rolled(&game, 0, [3, 6]);

        assert_eq!(game.position.turn, 1);
        assert_eq!(game.position.phase, Phase::Roll);
        assert_eq!(
            game.position.last_turn,
            Some(LastTurn {
                seat: 0,
                dice: [3, 6],
                played: vec![]
            })
        );
    }

    #[test]
    fn a_double_that_runs_out_of_moves_ends_the_turn() {
        // Seat 0's last checker plays one 2, and the opponent's point (own 24) stops it.
        let game = state(position(&[(20, 1)], &[(12, 15)], [14, 0]));

        let game = rolled(&game, 0, [2, 2]);
        let game = play(&game, 0, 20, 2).unwrap();

        assert_eq!(game.position.turn, 1);
        assert_eq!(game.position.points[0], points(&[(22, 1)]));
        assert_eq!(
            game.position.last_turn.map(|turn| turn.played),
            Some(vec![step(20, 2)])
        );
    }

    // --- The end of the game ---

    /// White (seat 0) has one checker left, on 24; Black has `black` and has borne off `off`.
    fn white_is_about_to_finish(black: &[(u8, u8)], off: u8) -> State {
        let mut position = position(&[(24, 1)], black, [14, off]);
        position.turns = [10, 9];
        state(position)
    }

    #[test]
    fn white_bearing_off_everything_gives_black_one_last_throw() {
        let game = white_is_about_to_finish(&[(19, 3)], 12);
        let game = rolled(&game, 0, [1, 4]);

        let game = play(&game, 0, 24, 4).unwrap();

        // The 4 is not played: White has nothing left.
        assert_eq!(game.position.off, [15, 12]);
        assert_eq!(game.position.phase, Phase::Roll);
        assert!(game.position.last_throw);
        assert_eq!(game.position.turn, 1);
        assert_eq!(
            game.position.last_turn,
            Some(LastTurn {
                seat: 0,
                dice: [1, 4],
                played: vec![step(24, 4)]
            })
        );
    }

    #[test]
    fn white_wins_one_point_if_black_does_not_bear_off_everything_on_the_last_throw() {
        let game = white_is_about_to_finish(&[(19, 3)], 12);
        let game = rolled(&game, 0, [1, 4]);
        let game = play(&game, 0, 24, 4).unwrap();

        let game = rolled(&game, 1, [2, 5]);
        let game = play(&game, 1, 19, 5).unwrap();
        let game = play(&game, 1, 19, 2).unwrap();

        assert_eq!(
            game.position.phase,
            Phase::Over {
                winner: Some(0),
                points: 1,
                forfeited: false,
            }
        );
        assert_eq!(game.legal, Vec::new());
    }

    #[test]
    fn bearing_off_everything_on_the_last_throw_is_a_draw() {
        let game = white_is_about_to_finish(&[(22, 1), (23, 1), (24, 1)], 12);
        let game = rolled(&game, 0, [1, 4]);
        let game = play(&game, 0, 24, 4).unwrap();

        // 6-6 takes all three off with the first three sixes.
        let game = rolled(&game, 1, [6, 6]);
        let game = play(&game, 1, 22, 6).unwrap();
        let game = play(&game, 1, 23, 6).unwrap();
        let game = play(&game, 1, 24, 6).unwrap();

        assert_eq!(
            game.position.phase,
            Phase::Over {
                winner: None,
                points: 0,
                forfeited: false,
            }
        );
    }

    #[test]
    fn white_wins_two_points_if_black_has_borne_off_nothing_after_the_last_throw() {
        // Mars, judged after the last throw (D5).
        let game = white_is_about_to_finish(&[(1, 15)], 0);
        let game = rolled(&game, 0, [1, 4]);
        let game = play(&game, 0, 24, 4).unwrap();

        let game = rolled(&game, 1, [2, 1]);
        let game = play(&game, 1, 1, 2).unwrap();
        let game = play(&game, 1, 3, 1).unwrap();

        assert_eq!(
            game.position.phase,
            Phase::Over {
                winner: Some(0),
                points: 2,
                forfeited: false,
            }
        );
    }

    #[test]
    fn black_wins_at_once_by_bearing_off_everything_first() {
        // Black is seat 1, with one checker left. White has borne off two.
        let mut about_to_finish = position(&[(19, 13)], &[(24, 1)], [2, 14]);
        about_to_finish.turn = 1;
        about_to_finish.turns = [9, 9];
        let game = state(about_to_finish);
        let game = rolled(&game, 1, [1, 3]);

        let game = play(&game, 1, 24, 3).unwrap();

        assert_eq!(
            game.position.phase,
            Phase::Over {
                winner: Some(1),
                points: 1,
                forfeited: false,
            }
        );
        assert!(!game.position.last_throw);
    }

    #[test]
    fn black_wins_two_points_when_white_has_borne_off_nothing() {
        let mut about_to_finish = position(&[(1, 15)], &[(24, 1)], [0, 14]);
        about_to_finish.turn = 1;
        about_to_finish.turns = [9, 9];
        let game = rolled(&state(about_to_finish), 1, [1, 3]);

        let game = play(&game, 1, 24, 3).unwrap();

        assert_eq!(
            game.position.phase,
            Phase::Over {
                winner: Some(1),
                points: 2,
                forfeited: false,
            }
        );
    }

    #[test]
    fn nothing_can_be_done_once_the_game_is_over() {
        let game = white_is_about_to_finish(&[(19, 3)], 12);
        let game = rolled(&game, 0, [1, 4]);
        let game = play(&game, 0, 24, 4).unwrap();
        let game = rolled(&game, 1, [2, 5]);
        let game = play(&game, 1, 19, 5).unwrap();
        let game = play(&game, 1, 19, 2).unwrap();

        for seat in [0, 1] {
            assert_eq!(
                reason(game.act(seat, Action::Roll, || Some([1, 1]))),
                "the game is over"
            );
            assert_eq!(reason(play(&game, seat, 19, 1)), "the game is over");
        }
    }

    // --- Storage and the wire ---

    #[test]
    fn the_state_has_the_shape_clients_expect() {
        let game = rolled(&fresh(1), 1, [5, 2]);

        let json = serde_json::to_value(&game).unwrap();

        let mut head = vec![15];
        head.extend([0; 23]);
        assert_eq!(
            json,
            json!({
                "white": 1,
                "points": [head, head],
                "off": [0, 0],
                "turn": 1,
                "turns": [0, 0],
                "lastThrow": false,
                "phase": { "type": "move", "dice": [5, 2], "remaining": [5, 2], "played": [] },
                "legal": [{ "from": 1, "die": 2 }, { "from": 1, "die": 5 }],
                "combos": [
                    [{ "from": 1, "die": 2 }, { "from": 3, "die": 5 }],
                    [{ "from": 1, "die": 5 }, { "from": 6, "die": 2 }],
                ],
                "lastTurn": null,
            })
        );
    }

    #[test]
    fn a_finished_game_has_the_shape_clients_expect() {
        let game = white_is_about_to_finish(&[(19, 3)], 12);
        let game = rolled(&game, 0, [1, 4]);
        let game = play(&game, 0, 24, 4).unwrap();

        let json = serde_json::to_value(&game).unwrap();

        assert_eq!(json["phase"], json!({ "type": "roll" }));
        assert_eq!(json["lastThrow"], true);
        assert_eq!(
            json["lastTurn"],
            json!({ "seat": 0, "dice": [1, 4], "played": [{ "from": 24, "die": 4 }] })
        );
    }

    fn reread(game: &State) -> State {
        serde_json::from_value(serde_json::to_value(game).unwrap()).unwrap()
    }

    fn recorded(game: &State) -> Value {
        LongBackgammon::record(game).expect("the state can be recorded")
    }

    #[test]
    fn a_record_is_the_position_without_what_is_worked_out_again() {
        let game = rolled(&fresh(1), 1, [5, 2]);

        let record = recorded(&game);

        let mut head = vec![15];
        head.extend([0; 23]);
        assert_eq!(
            record,
            json!({
                "white": 1,
                "points": [head, head],
                "off": [0, 0],
                "turn": 1,
                "turns": [0, 0],
                "lastThrow": false,
                "phase": { "type": "move", "dice": [5, 2], "remaining": [5, 2], "played": [] },
                "lastTurn": null,
            })
        );
        // So the whole state has what the record has, and more.
        let state = serde_json::to_value(&game).unwrap();
        for (key, value) in record.as_object().unwrap() {
            assert_eq!(&state[key], value, "{key}");
        }
    }

    #[test]
    fn a_state_survives_being_recorded_and_read_back() {
        let game = rolled(&fresh(0), 0, [4, 4]);
        let mid_turn = play(&game, 0, 1, 4).unwrap();
        let between_turns = white_is_about_to_finish(&[(19, 3)], 12);
        let between_turns = rolled(&between_turns, 0, [1, 4]);
        let between_turns = play(&between_turns, 0, 24, 4).unwrap();

        for game in [fresh(1), game, mid_turn, between_turns] {
            let read: State = serde_json::from_value(recorded(&game)).unwrap();
            assert_eq!(read, game);
        }
    }

    #[test]
    fn a_record_is_a_stored_state_the_server_can_load() {
        // A history row is read like a stored game, by the engine of its layout version.
        let engine = crate::game::Games::default()
            .with::<LongBackgammon>()
            .get(LongBackgammon::KIND)
            .unwrap()
            .clone();
        let game = rolled(&fresh(0), 0, [5, 2]);

        let live = engine
            .load(LongBackgammon::STATE_VERSION, recorded(&game))
            .expect("the record loads");

        assert_eq!(live.to_json(), Ok(serde_json::to_value(&game).unwrap()));
        assert_eq!(live.to_record(), Ok(recorded(&game)));
    }

    #[test]
    fn a_state_survives_being_stored_and_read_back() {
        let game = rolled(&fresh(0), 0, [4, 4]);
        let game = play(&game, 0, 1, 4).unwrap();

        assert_eq!(reread(&game), game);
        assert_eq!(reread(&fresh(1)), fresh(1));
    }

    #[test]
    fn what_is_legal_is_worked_out_again_when_a_state_is_read() {
        let game = rolled(&fresh(0), 0, [5, 2]);
        let mut json: Value = serde_json::to_value(&game).unwrap();
        json["legal"] = json!([{ "from": 24, "die": 6 }]);

        let read: State = serde_json::from_value(json).unwrap();

        assert_eq!(read.legal, vec![step(1, 2), step(1, 5)]);
    }

    #[test]
    fn the_combined_moves_are_worked_out_again_when_a_state_is_read() {
        let game = rolled(&fresh(0), 0, [5, 2]);
        let mut json: Value = serde_json::to_value(&game).unwrap();
        json["combos"] = json!([[{ "from": 24, "die": 6 }, { "from": 24, "die": 6 }]]);

        let read: State = serde_json::from_value(json).unwrap();

        assert_eq!(read.combos, game.combos);
        assert_eq!(read.combos.len(), 2);
    }

    #[test]
    fn there_are_no_combined_moves_outside_a_turn_in_progress() {
        assert_eq!(fresh(0).combos, Vec::<Vec<Step>>::new());

        // A roll with nothing to play ends the turn at once: own 15 and 16 are the opponent's
        // 3 and 4, so the checkers on 10 can play neither the 5 nor the 6.
        let stuck = position(
            &[(10, 15)],
            &[(23, 3), (24, 3), (1, 3), (2, 2), (3, 2), (4, 2)],
            [0, 0],
        );
        let game = rolled(&state(stuck), 0, [6, 5]);
        assert_eq!(game.position.phase, Phase::Roll);
        assert_eq!(game.combos, Vec::<Vec<Step>>::new());
    }

    #[test]
    fn a_combined_move_can_be_played_as_separate_moves_whatever_the_roll() {
        // The client plays a combo by sending its steps one at a time, so each step must be
        // legal when its turn comes, in the state the steps before it left.
        for a in 1..=6 {
            for b in a..=6 {
                let game = rolled(&fresh(0), 0, [a, b]);
                for line in &game.combos {
                    assert!(line.len() >= 2, "{line:?}");
                    let mut now = game.clone();
                    for &Step { from, die } in line {
                        assert!(now.legal.contains(&step(from, die)), "{a}-{b}: {line:?}");
                        now = play(&now, 0, from, die).expect("the step is accepted");
                    }
                }
            }
        }
    }

    #[test]
    fn a_stored_turn_with_nothing_left_to_play_ends() {
        // A state written by a server whose rules allowed a move that these rules don't.
        let mut json = serde_json::to_value(rolled(&fresh(0), 0, [5, 2])).unwrap();
        json["phase"]["remaining"] = json!([]);

        let read: State = serde_json::from_value(json).unwrap();

        assert_eq!(read.position.turn, 1);
        assert_eq!(read.position.phase, Phase::Roll);
    }

    #[test]
    fn a_state_that_cannot_be_right_is_refused_when_read() {
        let good = serde_json::to_value(rolled(&fresh(0), 0, [5, 2])).unwrap();
        let broken = |edit: &dyn Fn(&mut Value)| {
            let mut json = good.clone();
            edit(&mut json);
            serde_json::from_value::<State>(json).is_err()
        };

        assert!(broken(&|json| json["white"] = json!(2)));
        assert!(broken(&|json| json["turn"] = json!(5)));
        assert!(
            broken(&|json| json["off"] = json!([1, 0])),
            "checkers don't add up"
        );
        assert!(broken(&|json| json["phase"]["dice"] = json!([0, 9])));
        assert!(broken(&|json| json["phase"]["remaining"] = json!([200])));
        assert!(broken(&|json| json["points"][0][0] = json!(300)));
    }

    // --- Playing whole games ---

    /// A tiny deterministic generator, so that a failing game can be replayed.
    struct Lcg(u64);

    impl Lcg {
        fn below(&mut self, n: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 33) % n as u64) as usize
        }
    }

    /// Whether a player has a run of six or more points that nothing of the opponent's is
    /// in front of: the position the prime rule must never allow.
    fn has_forbidden_block(state: &State, seat: usize) -> bool {
        rules::forbidden_block(
            &state.position.points[seat],
            &state.position.points[1 - seat],
        )
    }

    /// Plays a game to the end with random legal choices, checking the invariants after
    /// every action. Returns the final state and how many actions it took.
    fn random_game(seed: u64) -> (State, usize) {
        let mut rng = Lcg(seed);
        let mut game = fresh(rng.below(2));
        let mut actions = 0;
        while !matches!(game.position.phase, Phase::Over { .. }) {
            assert!(actions < 20_000, "seed {seed}: the game does not end");
            let seat = game.position.turn;
            game = match &game.position.phase {
                Phase::Roll => {
                    let dice = [1 + rng.below(6) as u8, 1 + rng.below(6) as u8];
                    game.act(seat, Action::Roll, || Some(dice)).unwrap()
                }
                Phase::Move { .. } => {
                    assert!(
                        !game.legal.is_empty(),
                        "seed {seed}: a move phase with no move"
                    );
                    let chosen = game.legal[rng.below(game.legal.len())];
                    play(&game, seat, chosen.from, chosen.die)
                        .unwrap_or_else(|why| panic!("seed {seed}: {chosen:?}: {}", why.reason()))
                }
                Phase::Over { .. } => unreachable!(),
            };
            actions += 1;

            for seat in 0..2 {
                let position = &game.position;
                let on_board: u8 = position.points[seat].iter().sum();
                assert_eq!(
                    on_board + position.off[seat],
                    CHECKERS,
                    "seed {seed}: checkers"
                );
                assert!(
                    !has_forbidden_block(&game, seat),
                    "seed {seed}: a forbidden block"
                );
                for index in 1..=24u8 {
                    let mine = position.points[seat][usize::from(index) - 1];
                    let theirs = position.points[1 - seat][usize::from(rules::across(index)) - 1];
                    assert!(
                        mine == 0 || theirs == 0,
                        "seed {seed}: shared point {index}"
                    );
                }
            }
            assert_eq!(
                reread(&game),
                game,
                "seed {seed}: storing changes the state"
            );
            assert_eq!(
                serde_json::from_value::<State>(recorded(&game)).unwrap(),
                game,
                "seed {seed}: recording changes the state"
            );
        }
        (game, actions)
    }

    #[test]
    fn random_games_always_end_and_never_break_the_rules() {
        let mut outcomes = [0; 3];
        for seed in 0..60 {
            let (game, _) = random_game(seed);
            let Phase::Over { winner, points, .. } = game.position.phase else {
                unreachable!()
            };
            match winner {
                Some(winner) => {
                    assert!(points == 1 || points == 2);
                    outcomes[winner] += 1;
                }
                None => outcomes[2] += 1,
            }
        }

        // Someone wins most games, both seats get to win, and the last throw has some effect.
        assert!(outcomes[0] > 5 && outcomes[1] > 5, "{outcomes:?}");
    }

    // --- Forfeit (D10) ---

    fn forfeit(state: &State, seat: usize) -> Result<State, Rejection> {
        state.forfeit(seat)
    }

    fn forfeited(winner: usize) -> Phase {
        Phase::Over {
            winner: Some(winner),
            points: 1,
            forfeited: true,
        }
    }

    #[test]
    fn a_forfeit_ends_the_game_and_the_other_player_wins_one_point() {
        let game = fresh(0);

        let over = forfeit(&game, 0).unwrap();

        assert_eq!(over.position.phase, forfeited(1));
        assert!(LongBackgammon::is_over(&over));
        assert_eq!(over.legal, Vec::new());
        assert_eq!(over.combos, Vec::<Vec<Step>>::new());
    }

    #[test]
    fn a_forfeit_may_come_on_the_opponents_turn() {
        // White (seat 0) is to roll; Black gives up all the same.
        let over = forfeit(&fresh(0), 1).unwrap();

        assert_eq!(over.position.phase, forfeited(0));
    }

    #[test]
    fn a_forfeit_may_come_in_the_middle_of_a_turn() {
        let game = rolled(&fresh(0), 0, [5, 2]);
        let game = play(&game, 0, 1, 2).unwrap();
        assert!(matches!(game.position.phase, Phase::Move { .. }));

        assert_eq!(forfeit(&game, 0).unwrap().position.phase, forfeited(1));
        assert_eq!(forfeit(&game, 1).unwrap().position.phase, forfeited(0));
    }

    #[test]
    fn a_forfeit_scores_one_point_even_when_the_forfeiter_has_borne_off_nothing() {
        // Played to its end this would be a mars, worth 2: the loser has borne off nothing.
        let game = state(position(&[(1, 15)], &[(1, 15)], [0, 0]));

        let Phase::Over { points, .. } = forfeit(&game, 1).unwrap().position.phase else {
            panic!("not over");
        };

        assert_eq!(points, 1);
    }

    #[test]
    fn a_forfeit_in_the_last_throw_loses_whoever_gives_up() {
        // White has borne off everything and Black has the last throw, so White was winning.
        let last_throw = state(Position {
            last_throw: true,
            turn: 1,
            ..position(&[], &[(1, 15)], [15, 0])
        });

        assert_eq!(
            forfeit(&last_throw, 0).unwrap().position.phase,
            forfeited(1)
        );
        assert_eq!(
            forfeit(&last_throw, 1).unwrap().position.phase,
            forfeited(0)
        );
    }

    #[test]
    fn a_game_that_is_over_cannot_be_forfeited() {
        let over = forfeit(&fresh(0), 0).unwrap();
        assert_eq!(reason(forfeit(&over, 0)), "the game is over");
        assert_eq!(reason(forfeit(&over, 1)), "the game is over");

        let mut won = Position::new(0);
        won.phase = Phase::Over {
            winner: Some(0),
            points: 1,
            forfeited: false,
        };
        assert_eq!(reason(forfeit(&state(won), 1)), "the game is over");
    }

    #[test]
    fn nothing_is_played_after_a_forfeit() {
        let over = forfeit(&fresh(0), 0).unwrap();

        assert_eq!(
            reason(over.act(0, Action::Roll, || Some([1, 2]))),
            "the game is over"
        );
        assert_eq!(
            reason(over.act(1, Action::Roll, || Some([1, 2]))),
            "the game is over"
        );
    }

    #[test]
    fn only_the_two_seats_can_forfeit() {
        assert_eq!(reason(forfeit(&fresh(0), 2)), "there is no such seat");
    }

    #[test]
    fn a_forfeit_is_what_it_was_when_stored_and_read_again() {
        let over = forfeit(&rolled(&fresh(1), 1, [3, 4]), 1).unwrap();

        assert_eq!(reread(&over), over);
        let read: State = serde_json::from_value(recorded(&over)).unwrap();
        assert_eq!(read.position.phase, forfeited(0));
        assert_eq!(
            serde_json::to_value(&over).unwrap()["phase"],
            json!({ "type": "over", "winner": 0, "points": 1, "forfeited": true })
        );
    }

    #[test]
    fn a_game_stored_before_forfeits_existed_was_not_forfeited() {
        let mut won = Position::new(0);
        won.phase = Phase::Over {
            winner: Some(0),
            points: 2,
            forfeited: false,
        };
        let won = state(won);
        let mut json = serde_json::to_value(&won).unwrap();
        json["phase"].as_object_mut().unwrap().remove("forfeited");

        let read: State = serde_json::from_value(json).unwrap();

        assert_eq!(read, won);
    }

    #[test]
    fn a_stored_forfeit_without_a_winner_is_refused() {
        let mut json = serde_json::to_value(forfeit(&fresh(0), 0).unwrap()).unwrap();
        json["phase"]["winner"] = Value::Null;

        assert!(serde_json::from_value::<State>(json).is_err());
    }
}
