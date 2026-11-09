//! The computer opponent of ultimate tic-tac-toe.
//!
//! It plays one mark at a time and keeps nothing between them. Of the cells the rules allow
//! (the empty ones of `State::playable`) it takes one that ranks best, and picks at random
//! among the ones that tie. It only has to be playable, not good: it looks at the mark it is
//! about to make and the answer it invites, and no further. In order of importance, a mark:
//!
//! 1. wins the game,
//! 2. wins a small board,
//! 3. blocks the opponent, who could win this small board with the same cell,
//! 4. doesn't send the opponent to a board where they can win a small board at once.
//!
//! It can't break a rule, because it picks from what the rules allow.

use super::{
    Action, Phase, State,
    rules::{self, BoardState, Cells, Outcome},
};

/// The action the bot plays for `seat`, or `None` if it isn't `seat`'s turn or the game is over.
pub fn action(state: &State, seat: usize) -> Option<Action> {
    let position = &state.position;
    if position.turn != seat || position.phase != Phase::Play {
        return None;
    }
    let mut best: Vec<(usize, usize)> = Vec::new();
    let mut top: Option<[bool; 4]> = None;
    for &board in &state.playable {
        for cell in 0..9 {
            if position.cells[board][cell].is_some() {
                continue;
            }
            let rank = rank(&position.cells, seat, board, cell);
            if top.is_none_or(|top| rank > top) {
                top = Some(rank);
                best.clear();
            }
            if top == Some(rank) {
                best.push((board, cell));
            }
        }
    }
    let (board, cell) = *best.get(random_below(best.len())?)?;
    Some(Action::Play { board, cell })
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

/// A fair number from 0 up to, not including, `n`; `None` for `n == 0` or if the system has
/// no random source. A byte has 256 values, which `n` need not divide, so the last few are skipped.
fn random_below(n: usize) -> Option<usize> {
    if n == 0 || n > 256 {
        return None;
    }
    let limit = 256 - 256 % n;
    loop {
        let mut byte = [0u8; 1];
        getrandom::fill(&mut byte).ok()?;
        if usize::from(byte[0]) < limit {
            return Some(usize::from(byte[0]) % n);
        }
    }
}
