//! The pure rules of ultimate tic-tac-toe, from `docs/games/ultimate-tic-tac-toe.md`: the lines,
//! what state a small board is in, which boards the sending rule allows, and how a game stands.
//! Nothing here remembers anything: the game around it is in the parent module.
//!
//! Boards and cells are counted from 0 here (the doc counts from 1), in reading order:
//!
//! ```text
//! 0 1 2
//! 3 4 5
//! 6 7 8
//! ```
//!
//! The same numbering is used for the cells of a small board and for the small boards of the big
//! one, so a mark in cell `c` sends the opponent to board `c`.

use serde::{Deserialize, Serialize};

/// The eight lines, at both levels: the rows, the columns, and the two diagonals.
pub const LINES: [[usize; 3]; 8] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
];

/// The nine cells of a small board, each holding the seat that marked it.
pub type Board = [Option<usize>; 9];

/// All 81 cells: `cells[board][cell]`.
pub type Cells = [Board; 9];

/// Where a small board stands. A board that is won or drawn is closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BoardState {
    /// Not won, and with an empty cell: moves can be played in it.
    Open,
    /// Full, with no line of one player's marks. It belongs to nobody (D5).
    Drawn,
    Won {
        seat: usize,
    },
}

/// The first line of three cells that `seat` holds in `board`, if there is one.
pub fn line_of(board: &Board, seat: usize) -> Option<[usize; 3]> {
    LINES
        .into_iter()
        .find(|line| line.iter().all(|&cell| board[cell] == Some(seat)))
}

/// Where a small board stands. A line wins the board even when the board is full (D6).
pub fn board_state(board: &Board) -> BoardState {
    for seat in 0..2 {
        if line_of(board, seat).is_some() {
            return BoardState::Won { seat };
        }
    }
    if board.iter().all(Option::is_some) {
        BoardState::Drawn
    } else {
        BoardState::Open
    }
}

/// Where each small board stands.
pub fn boards(cells: &Cells) -> [BoardState; 9] {
    cells.map(|board| board_state(&board))
}

/// The first line of three small boards that `seat` has won, if there is one. A drawn board
/// belongs to nobody, so a line through it is never made (D5).
pub fn won_line(boards: &[BoardState; 9], seat: usize) -> Option<[usize; 3]> {
    LINES
        .into_iter()
        .find(|line| line.iter().all(|&b| boards[b] == BoardState::Won { seat }))
}

/// How a game stands, from the state of its small boards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// There is a board to play in and nobody has a line.
    Going,
    /// `seat` has three boards in `line`.
    Won { seat: usize, line: [usize; 3] },
    /// Every board is closed and nobody has a line.
    Drawn,
}

/// How a game stands. A line wins at once, whatever the other boards look like; otherwise the
/// game is a draw when no board is open (D4, D7).
pub fn outcome(boards: &[BoardState; 9]) -> Outcome {
    for seat in 0..2 {
        if let Some(line) = won_line(boards, seat) {
            return Outcome::Won { seat, line };
        }
    }
    if boards.contains(&BoardState::Open) {
        Outcome::Going
    } else {
        Outcome::Drawn
    }
}

/// The boards the player to move may play in. `sent_to` is the cell the opponent marked last,
/// which names the board to play in; `None` before the first move. A board that is closed
/// sends nobody anywhere in particular: any open board will do (D2, D3).
pub fn playable(boards: &[BoardState; 9], sent_to: Option<usize>) -> Vec<usize> {
    if let Some(board) = sent_to
        && boards[board] == BoardState::Open
    {
        return vec![board];
    }
    (0..9).filter(|&b| boards[b] == BoardState::Open).collect()
}

/// Whether a mark of `seat` in the empty `cell` of `board` would make a line in it.
pub fn would_win(board: &Board, seat: usize, cell: usize) -> bool {
    if board[cell].is_some() {
        return false;
    }
    let mut marked = *board;
    marked[cell] = Some(seat);
    line_of(&marked, seat).is_some()
}
