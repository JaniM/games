//! The computer opponent of ultimate tic-tac-toe, at each of its three levels (see
//! [`crate::bot`]).
//!
//! It plays one mark at a time and keeps nothing between them. Of the cells the rules allow
//! (the empty ones of `State::playable`) it takes one, and can't break a rule, because it picks
//! from what the rules allow.
//!
//! - **Easy** takes any of them, at random.
//! - **Medium** looks at the mark it is about to make and the answer it invites, and no
//!   further. It takes one that ranks best, and picks at random among the ones that tie. In
//!   order of importance, a mark:
//!
//!   1. wins the game,
//!   2. wins a small board,
//!   3. blocks the opponent, who could win this small board with the same cell,
//!   4. doesn't send the opponent to a board where they can win a small board at once.
//!
//! - **Hard** searches several moves ahead ([`search`]).

mod search;

use super::{
    Action, Phase, State,
    rules::{self, BoardState, Cells, Outcome},
};
use crate::bot::{Level, Random};

/// Whether the bot has a mark to make for `seat`: it is `seat`'s turn and the game is on.
pub fn to_move(state: &State, seat: usize) -> bool {
    state.position.turn == seat && state.position.phase == Phase::Play
}

/// The action the bot plays for `seat` at `level`, or `None` if it isn't `seat`'s turn or the
/// game is over, or `rng` has nothing to choose with.
pub fn action(state: &State, seat: usize, level: Level, rng: &mut dyn Random) -> Option<Action> {
    if !to_move(state, seat) {
        return None;
    }
    let (board, cell) = match level {
        Level::Easy => any(state, rng)?,
        Level::Medium => likeliest(state, seat, rng)?,
        Level::Hard => search::choose(state, rng)?,
    };
    Some(Action::Play { board, cell })
}

/// The empty cells the rules allow, as (board, cell).
fn allowed(state: &State) -> impl Iterator<Item = (usize, usize)> + '_ {
    state.playable.iter().flat_map(move |&board| {
        (0..9)
            .filter(move |&cell| state.position.cells[board][cell].is_none())
            .map(move |cell| (board, cell))
    })
}

/// Any move at all.
fn any(state: &State, rng: &mut dyn Random) -> Option<(usize, usize)> {
    let moves: Vec<_> = allowed(state).collect();
    moves.get(rng.below(moves.len())?).copied()
}

/// A move of the best rank, which is the medium bot's.
fn likeliest(state: &State, seat: usize, rng: &mut dyn Random) -> Option<(usize, usize)> {
    let mut best: Vec<(usize, usize)> = Vec::new();
    let mut top: Option<[bool; 4]> = None;
    for (board, cell) in allowed(state) {
        let rank = rank(&state.position.cells, seat, board, cell);
        if top.is_none_or(|top| rank > top) {
            top = Some(rank);
            best.clear();
        }
        if top == Some(rank) {
            best.push((board, cell));
        }
    }
    best.get(rng.below(best.len())?).copied()
}

/// How good a mark of `seat` in `cell` of `board` is, as the four yes-or-no answers in the
/// order of the module docs. A better rank is greater: the first answer that differs decides.
fn rank(cells: &Cells, seat: usize, board: usize, cell: usize) -> [bool; 4] {
    let other = 1 - seat;
    let blocks = rules::would_win(&cells[board], other, cell);

    let mut after = *cells;
    after[board][cell] = Some(seat);
    let boards = rules::boards(&after);
    let wins_board = boards[board] == BoardState::Won { seat };
    let wins_game = matches!(
        rules::outcome(&boards),
        Outcome::Won { seat: winner, .. } if winner == seat
    );

    // Where the opponent plays next, and whether they can win a small board there.
    let danger = rules::playable(&boards, Some(cell))
        .into_iter()
        .any(|target| (0..9).any(|c| rules::would_win(&after[target], other, c)));

    [wins_game, wins_board, blocks, !danger]
}
