//! Ultimate tic-tac-toe as a [`Game`]. The rules are in `docs/games/ultimate-tic-tac-toe.md`;
//! follow them exactly, and ask before deviating.
//!
//! [`rules`] is the pure part: lines, the state of a small board, the sending rule and how a
//! game stands. This module is the game around it: whose turn it is, placing a mark, ending
//! the game, and forfeits.
//!
//! # The state
//!
//! The state is addressed by **seat**, the player's place in the room (0 is whoever created the
//! game). X is the player who moves first, picked at random when the game starts, and is `x` in
//! the state. Boards and cells are counted **from 0** here, where the doc counts from 1, in
//! reading order (see [`rules`]); `cells[b][c]` is cell `c` of small board `b`, and a mark in
//! cell `c` sends the opponent to board `c`. In JSON (camelCase):
//!
//! ```json
//! { "x": 0,
//!   "cells": [[null, 0, 1, …], …],
//!   "turn": 0,
//!   "last": null,
//!   "phase": { "type": "play" },
//!   "boards": [{ "type": "open" }, { "type": "drawn" }, { "type": "won", "seat": 0 }, …],
//!   "playable": [0, 1, 2, 3, 4, 5, 6, 7, 8],
//!   "line": null }
//! ```
//!
//! - `cells`: nine rows of nine, each the seat that marked the cell, or null.
//! - `turn`: the seat to move; after the game, the seat that moved last (a move that ends the
//!   game doesn't pass the turn on, and a forfeit doesn't change it).
//! - `last`: null before the first move, then `{ "seat": 0, "board": 4, "cell": 2 }`, the last
//!   mark placed. It is kept when the game ends, and a forfeit leaves it.
//! - `phase`: `{ "type": "play" }`, or `{ "type": "over", "winner": 0, "forfeited": false }`.
//!   `winner` is a seat, or null for a draw. `forfeited` is true when the other player gave up
//!   (D10): `winner` is the other seat.
//!
//! Those five are the **position**: all the game keeps. The rest is worked out from it, written
//! out for clients so that they need no rules, and worked out again whenever a state is read, so
//! it never needs an upgrade and a stored game follows the rules of the server that loads it:
//!
//! - `boards`: where each small board stands (derived from `cells`): `open`, `drawn` (full, and
//!   nobody's, D5) or `won` by `seat`.
//! - `playable`: the boards the player to move may play in (the sending rule, D2, D3): the one
//!   the last mark named if it is open, else every open board. Any empty cell of those is a
//!   legal move. Empty unless the phase is `play`.
//! - `line`: the three small boards, in ascending order, that won the game, if it ended that way.
//!   A move may complete two lines at once, and then it is the first in the order rows,
//!   columns, diagonals. Null for a draw, a forfeit and a game that is on.
//!
//! The history keeps a state for every move, and a client draws a past position without knowing
//! the rules. So a record (see [`Game::record`]) is the state but for `playable`, which is worked
//! out again from the position whenever a state is read, and is not kept for every move. `boards`
//! and `line` stay in it: they are what each position looked like. When a client reads the history,
//! the game puts `playable` back ([`Game::history_view`]), so that a past position shows which
//! board the next mark went in, as the game does now. A record is read back like any state: the
//! derived fields are worked out again from the position.
//!
//! # Actions
//!
//! `{ "type": "play", "board": 4, "cell": 2 }` marks a cell for the player to move. There is no
//! action for passing (there is always a move, see the doc) or for taking a move back (D9).
//! Giving up is not an action either: a player sends the socket's own `forfeit` message (D10),
//! which is allowed on either turn.

mod bot;
mod picture;
mod rules;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    bot::{Level, System},
    game::{Game, Rejection, StateError},
};
use rules::{BoardState, Cells, Outcome};

/// The game itself. It has no data: everything is in its [`State`].
pub struct UltimateTicTacToe;

/// What a player may send.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// Marks cell `cell` of small board `board`, both counted from 0.
    Play { board: usize, cell: usize },
}

/// Where the game stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Phase {
    /// The player to move must place a mark.
    Play,
    Over {
        /// A seat, or none for a draw.
        winner: Option<usize>,
        /// The loser gave up (D10): `winner` is the other seat, and nobody had won on the board.
        forfeited: bool,
    },
}

/// The mark placed last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Last {
    seat: usize,
    board: usize,
    cell: usize,
}

/// The game as it stands, apart from what can be worked out from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Position {
    /// The seat that plays X and moves first.
    x: usize,
    cells: Cells,
    /// The seat to move; after the game, the seat that moved last.
    turn: usize,
    last: Option<Last>,
    phase: Phase,
}

/// A [`Position`] with what is worked out from it. This is what is stored and sent.
///
/// `boards`, `playable` and `line` are derived: they are written out for clients, and read back
/// by working them out again from the position, whatever the JSON says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Position")]
pub struct State {
    #[serde(flatten)]
    position: Position,
    boards: [BoardState; 9],
    playable: Vec<usize>,
    line: Option<[usize; 3]>,
}

impl TryFrom<Position> for State {
    type Error = String;

    /// Checks that the position is one the game could be in, then works out the rest.
    fn try_from(position: Position) -> Result<Self, String> {
        position.validate()?;
        let boards = rules::boards(&position.cells);
        let playable = match position.phase {
            Phase::Play => rules::playable(&boards, position.last.map(|last| last.cell)),
            Phase::Over { .. } => Vec::new(),
        };
        let line = match (position.phase, rules::outcome(&boards)) {
            (
                Phase::Over {
                    forfeited: false, ..
                },
                Outcome::Won { line, .. },
            ) => Some(line),
            _ => None,
        };
        Ok(Self {
            position,
            boards,
            playable,
            line,
        })
    }
}

impl Position {
    /// A new game: nothing marked, and X to move.
    fn new(x: usize) -> Self {
        Self {
            x,
            cells: [[None; 9]; 9],
            turn: x,
            last: None,
            phase: Phase::Play,
        }
    }

    /// Checks that the game could be in this position. It doesn't replay the game, so it can't
    /// know that a position was reached by legal moves, but it refuses the ones that fit no game.
    fn validate(&self) -> Result<(), String> {
        if self.x > 1 || self.turn > 1 {
            return Err("a seat is 0 or 1".to_owned());
        }
        let mut marks = [0usize; 2];
        for mark in self.cells.iter().flatten().flatten() {
            match marks.get_mut(*mark) {
                Some(count) => *count += 1,
                None => return Err(format!("seat {mark} marked a cell")),
            }
        }
        // X moves first, so they have as many marks as O, or one more.
        let (xs, os) = (marks[self.x], marks[1 - self.x]);
        if xs != os && xs != os + 1 {
            return Err("the marks don't alternate between the players".to_owned());
        }
        let played = xs + os;
        let to_move = if played % 2 == 0 { self.x } else { 1 - self.x };
        let last_mover = 1 - to_move;

        match self.last {
            None if played > 0 => return Err("there are marks but no last mark".to_owned()),
            None => {}
            Some(_) if played == 0 => return Err("there is a last mark but no marks".to_owned()),
            Some(last) => {
                if last.board > 8 || last.cell > 8 {
                    return Err("the last mark is not on the board".to_owned());
                }
                if last.seat != last_mover || self.cells[last.board][last.cell] != Some(last.seat) {
                    return Err(
                        "the last mark is not a mark of the player who moved last".to_owned()
                    );
                }
            }
        }

        if self
            .cells
            .iter()
            .any(|board| rules::line_of(board, 0).is_some() && rules::line_of(board, 1).is_some())
        {
            return Err("both players have a line in one small board".to_owned());
        }
        let boards = rules::boards(&self.cells);
        if rules::won_line(&boards, 0).is_some() && rules::won_line(&boards, 1).is_some() {
            return Err("both players have a line of small boards".to_owned());
        }

        match (self.phase, rules::outcome(&boards)) {
            (Phase::Play, Outcome::Going) if self.turn == to_move => Ok(()),
            (Phase::Play, Outcome::Going) => Err("it is the other player's turn".to_owned()),
            (Phase::Play, _) => Err("the game has ended, but is still being played".to_owned()),
            (
                Phase::Over {
                    winner: Some(winner),
                    forfeited: true,
                },
                Outcome::Going,
            ) if winner < 2 && self.turn == to_move => Ok(()),
            (
                Phase::Over {
                    forfeited: true, ..
                },
                Outcome::Going,
            ) => Err("a forfeit has a winner, and doesn't change whose turn it is".to_owned()),
            (
                Phase::Over {
                    forfeited: true, ..
                },
                _,
            ) => Err("a game that had ended was given up".to_owned()),
            (
                Phase::Over {
                    winner,
                    forfeited: false,
                },
                outcome,
            ) => {
                let ended = match outcome {
                    Outcome::Won { seat, .. } => Some(Some(seat)),
                    Outcome::Drawn => Some(None),
                    Outcome::Going => None,
                };
                if ended != Some(winner) {
                    return Err("the result doesn't match the boards".to_owned());
                }
                if self.turn != last_mover {
                    return Err("after the game the turn is the last player's".to_owned());
                }
                Ok(())
            }
        }
    }
}

impl State {
    /// A position that the rules reached. Panics only if it is not one, which would be a
    /// bug in this module.
    fn reached(position: Position) -> Self {
        Self::try_from(position).expect("the rules only reach valid positions")
    }

    /// The state after `seat` plays `action`, or why they can't.
    fn act(&self, seat: usize, action: Action) -> Result<State, Rejection> {
        let Action::Play { board, cell } = action;
        let position = &self.position;
        if position.phase != Phase::Play {
            return Err(Rejection::new("the game is over"));
        }
        if seat != position.turn {
            return Err(Rejection::new("not your turn"));
        }
        if board > 8 || cell > 8 {
            return Err(Rejection::new("there is no such cell"));
        }
        if !self.playable.contains(&board) {
            return Err(Rejection::new(match self.boards[board] {
                BoardState::Open => {
                    // The sending rule names a single board, or else every open one is playable.
                    format!(
                        "you must play in board {}, where the last mark sent you",
                        self.playable.first().map_or(0, |forced| forced + 1)
                    )
                }
                _ => "that board is already decided".to_owned(),
            }));
        }
        if position.cells[board][cell].is_some() {
            return Err(Rejection::new("that cell is already taken"));
        }

        let mut position = position.clone();
        position.cells[board][cell] = Some(seat);
        position.last = Some(Last { seat, board, cell });
        // The board first, then the big board, then whether any board is left (the doc's order).
        match rules::outcome(&rules::boards(&position.cells)) {
            Outcome::Won { seat: winner, .. } => {
                position.phase = Phase::Over {
                    winner: Some(winner),
                    forfeited: false,
                };
            }
            Outcome::Drawn => {
                position.phase = Phase::Over {
                    winner: None,
                    forfeited: false,
                };
            }
            Outcome::Going => position.turn = 1 - seat,
        }
        Ok(Self::reached(position))
    }

    /// The state after `seat` gives up (D10): the other seat wins. Not a move, so it is allowed
    /// on either turn, and before the first move. A game that is over can't be given up.
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
            forfeited: true,
        };
        Ok(Self::reached(position))
    }
}

impl Game for UltimateTicTacToe {
    const KIND: &'static str = "ultimate-tic-tac-toe";
    const NAME: &'static str = "Ultimate tic-tac-toe";
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

    /// The state without `playable`, which a state read back works out again from the position and
    /// which the history would otherwise keep for every move. A client is given it back when it
    /// reads the history ([`Game::history_view`]); `boards` and `line` stay, as they are what a past
    /// position looks like.
    fn record(state: &State) -> Result<Value, StateError> {
        let mut record = serde_json::to_value(state)
            .map_err(|err| StateError::new(format!("could not write a state as JSON: {err}")))?;
        if let Some(fields) = record.as_object_mut() {
            fields.remove("playable");
        }
        Ok(record)
    }

    /// The record with `playable` back, worked out again from the position as a stored game's is:
    /// which board the position sent the player to. A client draws a past position as it draws the
    /// game now, and a spectator, who is always in review, would otherwise never see where the next
    /// mark goes. It is the state a room would send for that position.
    fn history_view(record: Value) -> Result<Value, StateError> {
        let state = serde_json::from_value::<State>(record)
            .map_err(|err| StateError::new(format!("state does not fit the game: {err}")))?;
        serde_json::to_value(&state)
            .map_err(|err| StateError::new(format!("could not write a state as JSON: {err}")))
    }

    /// Picks X at random: the doc lets the starter be chosen any way, as long as X starts (D1).
    fn start() -> State {
        let mut byte = [0u8; 1];
        getrandom::fill(&mut byte).expect("the system's random source works");
        State::reached(Position::new(usize::from(byte[0] & 1)))
    }

    fn apply(state: &State, seat: usize, action: Action) -> Result<State, Rejection> {
        state.act(seat, action)
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

#[cfg(test)]
mod tests;
