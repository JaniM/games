//! Hex as a [`Game`]. The rules are in `docs/games/hex.md`; follow them exactly, and ask before
//! deviating.
//!
//! [`rules`] is the pure part: the board, which cells touch, the mirror and the connections. This
//! module is the game around it: whose turn it is, placing a stone, the swap, ending the game, and
//! forfeits.
//!
//! # The state
//!
//! The state is addressed by **seat**, the player's place in the room (0 is whoever created the
//! game). Red is the player who moves first, picked at random when the game starts, and is `red` in
//! the state; the other seat is Blue. Columns and rows are counted **from 0** here: the doc's `a1`
//! is column 0, row 0, and `k11` is column 10, row 10 (see [`rules`]). In JSON (camelCase):
//!
//! ```json
//! { "size": 11,
//!   "red": 0,
//!   "cells": [null, 0, null, …],
//!   "turn": 1,
//!   "swapped": false,
//!   "last": { "seat": 0, "column": 1, "row": 0, "swap": false },
//!   "phase": { "type": "play" },
//!   "canSwap": true,
//!   "chain": null }
//! ```
//!
//! - `size`: the cells on a side of the board. Only 11 for now (D1), and a state of another size
//!   is refused when it is read, because the rules of this server are for 11 (see [`rules`]). It is
//!   in the state so that a choice of sizes needs no new layout.
//! - `cells`: the board row by row, `size` × `size` cells, each the seat whose stone is there, or
//!   null. The cell in `column` and `row` is `cells[row * size + column]`, which for the size the
//!   rules play is also the cell's number in [`rules`].
//! - `turn`: the seat to move; after the game, the seat that moved last (a move that ends the game
//!   doesn't pass the turn on, and a forfeit doesn't change it).
//! - `swapped`: Blue has swapped (D3, D4). It never changes back.
//! - `last`: null before the first move, then the last move: the stone it placed, and whose it is.
//!   For a swap (`"swap": true`) that is Blue's stone on the mirror cell, and the Red stone it took
//!   away was on the mirror of that: column and row the other way round. It is kept when the game
//!   ends, and a forfeit leaves it.
//! - `phase`: `{ "type": "play" }`, or `{ "type": "over", "winner": 0, "forfeited": false }`. There
//!   are no draws, so there is always a winner. `forfeited` is true when the other player gave up
//!   (D9).
//!
//! Those six are the **position**: all the game keeps. The rest is worked out from it, written out
//! for clients so that they need no rules, and worked out again whenever a state is read, so it
//! never needs an upgrade and a stored game follows the rules of the server that loads it:
//!
//! - `canSwap`: the player to move may swap now, which is only on Blue's first turn.
//! - `chain`: the cells of the winner's chain that connects their edges, in reading order (row by
//!   row), as `{ "column": 3, "row": 0 }`. Null for a forfeit and a game that is on.
//!
//! The history keeps the whole state for every move (the default [`Game::record`]): `canSwap` is a
//! flag and `chain` is null until the end, so there is nothing worth leaving out.
//!
//! # Actions
//!
//! `{ "type": "place", "column": 5, "row": 5 }` puts a stone of the player to move on an empty
//! cell. `{ "type": "swap" }` is Blue's swap, on Blue's first turn only. There is no action for
//! passing (D7) or for taking a move back (D8). Giving up is not an action either: a player sends
//! the socket's own `forfeit` message (D9), which is allowed on either turn.

mod picture;
mod rules;

use serde::{Deserialize, Serialize};

use crate::game::{Game, Rejection};
use rules::{Bits, Colour, SIZE};

/// The game itself. It has no data: everything is in its [`State`].
pub struct Hex;

/// What a player may send.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// Puts a stone on the empty cell in `column` and `row`, both counted from 0.
    Place { column: usize, row: usize },
    /// Blue's swap (D4): Red's first stone becomes Blue's, on the mirror cell.
    Swap,
}

/// Where the game stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Phase {
    /// The player to move must place a stone, or swap if they may.
    Play,
    Over {
        winner: usize,
        /// The loser gave up (D9): `winner` is the other seat, and nobody had connected.
        forfeited: bool,
    },
}

/// The last move: the stone it placed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Last {
    seat: usize,
    column: usize,
    row: usize,
    /// The move was the swap, and the stone is the one it put on the mirror cell.
    swap: bool,
}

/// A cell, as the state names it to clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Cell {
    column: usize,
    row: usize,
}

/// The stones on the board, row by row: `cells[row * size + column]` is the seat whose stone is on
/// the cell in `column` and `row`.
type Cells = Vec<Option<usize>>;

/// The game as it stands, apart from what can be worked out from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Position {
    /// The cells on a side of the board.
    size: usize,
    /// The seat that plays Red and moves first.
    red: usize,
    cells: Cells,
    /// The seat to move; after the game, the seat that moved last.
    turn: usize,
    /// Blue has swapped.
    swapped: bool,
    last: Option<Last>,
    phase: Phase,
}

/// A [`Position`] with what is worked out from it. This is what is stored and sent.
///
/// `can_swap` and `chain` are derived: they are written out for clients, and read back by working
/// them out again from the position, whatever the JSON says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Position", rename_all = "camelCase")]
pub struct State {
    #[serde(flatten)]
    position: Position,
    can_swap: bool,
    chain: Option<Vec<Cell>>,
}

impl TryFrom<Position> for State {
    type Error = String;

    /// Checks that the position is one the game could be in, then works out the rest.
    fn try_from(position: Position) -> Result<Self, String> {
        position.validate()?;
        let stones = position.stones();
        let can_swap = position.phase == Phase::Play
            && position.turn != position.red
            && stones[0].count_ones() == 1
            && stones[1] == 0;
        let chain = match position.phase {
            Phase::Over {
                winner,
                forfeited: false,
            } => {
                let colour = position.colour_of(winner);
                let chain = rules::winning_chain(stones[colour.index()], colour);
                Some(
                    rules::cells_of(chain)
                        .map(|cell| {
                            let (column, row) = rules::place(cell);
                            Cell { column, row }
                        })
                        .collect(),
                )
            }
            _ => None,
        };
        Ok(Self {
            position,
            can_swap,
            chain,
        })
    }
}

impl Position {
    /// A new game: an empty board, and Red to move.
    fn new(red: usize) -> Self {
        Self {
            size: SIZE,
            red,
            cells: vec![None; SIZE * SIZE],
            turn: red,
            swapped: false,
            last: None,
            phase: Phase::Play,
        }
    }

    /// The colour `seat` plays.
    fn colour_of(&self, seat: usize) -> Colour {
        if seat == self.red {
            Colour::Red
        } else {
            Colour::Blue
        }
    }

    /// The seat that plays `colour`.
    fn seat_of(&self, colour: Colour) -> usize {
        match colour {
            Colour::Red => self.red,
            Colour::Blue => 1 - self.red,
        }
    }

    /// Where the cell in `column` and `row` is in `cells`.
    fn at(&self, column: usize, row: usize) -> usize {
        row * self.size + column
    }

    /// The stones of each colour, Red's first, as sets of cells. Only call it on a position whose
    /// board is the size the rules play, and whose cells hold seats 0 and 1: then a cell's place in
    /// `cells` is its number in [`rules`].
    fn stones(&self) -> [Bits; 2] {
        let mut stones = [0; 2];
        for (cell, seat) in self.cells.iter().enumerate() {
            if let Some(seat) = *seat {
                stones[self.colour_of(seat).index()] |= rules::bit(cell);
            }
        }
        stones
    }

    /// Checks that the game could be in this position. It doesn't replay the game, so it can't
    /// know that a position was reached by legal moves, but it refuses the ones that fit no game.
    fn validate(&self) -> Result<(), String> {
        // Before anything else, because the rest reads the board as one of the size the rules know.
        if self.size != SIZE {
            return Err(format!(
                "a board {0} by {0} is not one this server plays: only {SIZE} by {SIZE}",
                self.size
            ));
        }
        if self.cells.len() != self.size * self.size {
            return Err(format!(
                "there are {} cells, not the {} of a board {2} by {2}",
                self.cells.len(),
                self.size * self.size,
                self.size
            ));
        }
        if self.red > 1 || self.turn > 1 {
            return Err("a seat is 0 or 1".to_owned());
        }
        if self.cells.iter().flatten().any(|&seat| seat > 1) {
            return Err("a stone belongs to a seat that is not 0 or 1".to_owned());
        }
        let stones = self.stones();
        let (reds, blues) = (stones[0].count_ones(), stones[1].count_ones());
        // Red moves first, so Red has as many stones as Blue, or one more. The swap takes Red's
        // first stone and gives Blue one, and from then on Blue is the one who is one ahead.
        let to_move = match (
            self.swapped,
            reds.checked_sub(blues),
            blues.checked_sub(reds),
        ) {
            (false, Some(0), _) => Colour::Red,
            (false, Some(1), _) => Colour::Blue,
            (true, _, Some(1)) => Colour::Red,
            (true, _, Some(0)) if blues > 0 => Colour::Blue,
            _ => return Err("the stones don't alternate between the players".to_owned()),
        };
        let to_move = self.seat_of(to_move);
        let last_mover = 1 - to_move;

        match self.last {
            None if reds + blues > 0 => return Err("there are stones but no last move".to_owned()),
            None => {}
            Some(_) if reds + blues == 0 => {
                return Err("there is a last move but no stones".to_owned());
            }
            Some(last) => {
                if last.column >= self.size || last.row >= self.size {
                    return Err("the last stone is not on the board".to_owned());
                }
                if last.seat != last_mover
                    || self.cells[self.at(last.column, last.row)] != Some(last.seat)
                {
                    return Err(
                        "the last stone is not a stone of the player who moved last".to_owned()
                    );
                }
                // The swap is the last move only until Red answers it, when the board holds the one
                // stone it put there.
                let just_swapped = self.swapped && reds == 0;
                if last.swap != just_swapped {
                    return Err(
                        "the last move is a swap exactly when the swap was the last move"
                            .to_owned(),
                    );
                }
            }
        }

        // Both can't have connected: a way down and a way across would cross, on a cell that can't
        // hold a stone of each.
        let winner = Colour::BOTH
            .into_iter()
            .find(|&colour| rules::connected(stones[colour.index()], colour))
            .map(|colour| self.seat_of(colour));

        match (self.phase, winner) {
            (Phase::Play, None) if self.turn == to_move => Ok(()),
            (Phase::Play, None) => Err("it is the other player's turn".to_owned()),
            (Phase::Play, Some(_)) => {
                Err("the game has ended, but is still being played".to_owned())
            }
            (
                Phase::Over {
                    winner,
                    forfeited: true,
                },
                None,
            ) if winner < 2 && self.turn == to_move => Ok(()),
            (
                Phase::Over {
                    forfeited: true, ..
                },
                None,
            ) => Err("a forfeit has a winner, and doesn't change whose turn it is".to_owned()),
            (
                Phase::Over {
                    forfeited: true, ..
                },
                Some(_),
            ) => Err("a game that had ended was given up".to_owned()),
            (
                Phase::Over {
                    winner,
                    forfeited: false,
                },
                connected,
            ) => {
                if connected != Some(winner) {
                    return Err("the winner is not the player who connected their edges".to_owned());
                }
                if winner != last_mover || self.turn != last_mover {
                    return Err(
                        "the game is won by the player who moved last, and it stays their turn"
                            .to_owned(),
                    );
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
        if self.position.phase != Phase::Play {
            return Err(Rejection::new("the game is over"));
        }
        if seat != self.position.turn {
            return Err(Rejection::new("not your turn"));
        }
        let mut position = self.position.clone();
        match action {
            Action::Place { column, row } => {
                if column >= position.size || row >= position.size {
                    return Err(Rejection::new("there is no such cell"));
                }
                let cell = position.at(column, row);
                if position.cells[cell].is_some() {
                    return Err(Rejection::new("that cell is already taken"));
                }
                position.cells[cell] = Some(seat);
                position.last = Some(Last {
                    seat,
                    column,
                    row,
                    swap: false,
                });
            }
            Action::Swap => {
                if !self.can_swap {
                    return Err(Rejection::new(
                        "the swap is only for Blue's first turn, instead of placing a stone",
                    ));
                }
                let Some(red) = self.position.last else {
                    unreachable!("Blue may swap only once Red has placed a stone");
                };
                // Red's stone goes, and Blue's goes on the mirror cell, which may be the same one.
                // The board is the size the rules play, so a cell's place is its number there.
                let from = position.at(red.column, red.row);
                let to = rules::mirror(from);
                position.cells[from] = None;
                position.cells[to] = Some(seat);
                position.swapped = true;
                position.last = Some(Last {
                    seat,
                    column: red.row,
                    row: red.column,
                    swap: true,
                });
            }
        }
        let colour = position.colour_of(seat);
        if rules::connected(position.stones()[colour.index()], colour) {
            position.phase = Phase::Over {
                winner: seat,
                forfeited: false,
            };
        } else {
            position.turn = 1 - seat;
        }
        Ok(Self::reached(position))
    }

    /// The state after `seat` gives up (D9): the other seat wins. Not a move, so it is allowed
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
            winner: 1 - seat,
            forfeited: true,
        };
        Ok(Self::reached(position))
    }
}

impl Game for Hex {
    const KIND: &'static str = "hex";
    const NAME: &'static str = "Hex";
    const PLAYERS: usize = 2;
    const STATE_VERSION: u32 = 1;
    type State = State;
    type Action = Action;

    fn is_over(state: &State) -> bool {
        matches!(state.position.phase, Phase::Over { .. })
    }

    fn picture(state: Option<&State>) -> Option<String> {
        Some(picture::picture(state))
    }

    /// Picks Red at random: the doc lets the starter be chosen any way, as long as Red starts (D2).
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
}

#[cfg(test)]
mod tests;
