//! How the hard bot of ultimate tic-tac-toe looks ahead.
//!
//! It searches the game tree with alpha-beta pruning, a little deeper each round (iterative
//! deepening) until it has spent [`BUDGET`] positions, and plays the move that comes out best for
//! it, assuming that the opponent answers as well as they can. Positions where the game goes on
//! are scored by [`evaluate`]. A position where somebody has won is worth more the sooner it
//! comes, so that the bot wins as fast as it can and loses as slowly.
//!
//! The budget is a count of positions, not a time, so what it plays depends only on the state: a
//! slow machine plays the same moves, and a test can repeat a game. It is small enough to answer
//! in a few milliseconds, because a room waits for it.
//!
//! The search has its own compact picture of the game: a mark is a bit in a mask of the board's
//! nine cells. It takes only the lines from the rules ([`LINES`]); the tests check that it plays
//! by the same rules as the game.

use std::cmp::Reverse;

use super::super::{State, rules::LINES};
use crate::bot::Random;

/// How many positions one move may look at, which is about how far it can see: with nine or so
/// moves to choose from at each step that is a handful of moves ahead, and further where few
/// moves are left.
const BUDGET: u32 = 40_000;

/// What winning is worth. A win that comes later is worth a little less, by the number of moves
/// searched to reach it, so that the quickest win is the best one.
const WIN: i32 = 100_000;

/// What a small board is worth to whoever has won it, times how many lines of the big board
/// pass through it ([`REACH`]).
const BOARD: i32 = 4;

/// What one small board won in a line of the big board is worth, and two. A line that has a
/// drawn board or one of the other player's in it can't be won, and is worth nothing. Two with a
/// third still to win is a threat, which is why it is worth so much more than twice one.
const BIG_LINE: [i32; 3] = [0, 10, 60];

/// What one mark, and two, are worth in a line of a small board that is still open and that the
/// other player has no mark in, times how many lines of the big board the small board is on.
const SMALL_LINE: [i32; 3] = [0, 1, 5];

/// The nine cells of a board, all marked.
const FULL: u16 = 0x1ff;

/// How many lines of the big board go through each board, which says how much the board
/// matters: the centre is on four, a corner on three, an edge on two.
const REACH: [i32; 9] = [3, 2, 3, 2, 4, 2, 3, 2, 3];

/// The lines as masks of cells (or of boards, in the big board: the lines are the same).
const MASKS: [u16; 8] = {
    let mut masks = [0; 8];
    let mut i = 0;
    while i < 8 {
        masks[i] = (1 << LINES[i][0]) | (1 << LINES[i][1]) | (1 << LINES[i][2]);
        i += 1;
    }
    masks
};

/// Whether a set of cells (or boards) holds a line, for every set of nine.
const HAS_LINE: [bool; 512] = {
    let mut has = [false; 512];
    let mut set = 0;
    while set < 512 {
        let mut i = 0;
        while i < 8 {
            if set & MASKS[i] as usize == MASKS[i] as usize {
                has[set] = true;
            }
            i += 1;
        }
        set += 1;
    }
    has
};

fn has_line(set: u16) -> bool {
    HAS_LINE[usize::from(set)]
}

/// How a game that is over ended.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Over {
    Won(usize),
    Drawn,
}

/// The game as the search sees it. Small enough to copy, so a move makes a new one and nothing
/// has to be taken back.
#[derive(Clone, Copy)]
struct Position {
    /// The cells each seat has marked, by board.
    marks: [[u16; 9]; 2],
    /// The boards each seat has won.
    won: [u16; 2],
    /// The boards that are won or drawn.
    closed: u16,
    /// The boards the player to move may play in.
    allowed: u16,
    /// The seat to move.
    turn: usize,
    /// How the game ended, if the move that made this position ended it.
    over: Option<Over>,
}

impl Position {
    /// The position of a game that is going on.
    fn of(state: &State) -> Self {
        let mut marks = [[0u16; 9]; 2];
        for (board, cells) in state.position.cells.iter().enumerate() {
            for (cell, mark) in cells.iter().enumerate() {
                if let Some(seat) = mark {
                    marks[*seat][board] |= 1 << cell;
                }
            }
        }
        let mut won = [0u16; 2];
        let mut closed = 0u16;
        for (board, (&x, &o)) in marks[0].iter().zip(&marks[1]).enumerate() {
            for (seat, set) in [x, o].into_iter().enumerate() {
                if has_line(set) {
                    won[seat] |= 1 << board;
                }
            }
            if x | o == FULL {
                closed |= 1 << board;
            }
        }
        closed |= won[0] | won[1];
        Self {
            marks,
            won,
            closed,
            allowed: state
                .playable
                .iter()
                .fold(0, |mask, &board| mask | 1 << board),
            turn: state.position.turn,
            over: None,
        }
    }

    /// The cells of `board` that nobody has marked.
    fn empty(&self, board: usize) -> u16 {
        !(self.marks[0][board] | self.marks[1][board]) & FULL
    }

    /// The moves of the player to move as (board, cell), the likely best first, because the
    /// search prunes the most when it meets the best move first.
    fn moves(&self) -> Vec<(usize, usize)> {
        let you = 1 - self.turn;
        let mut found: Vec<(i32, usize, usize)> = Vec::with_capacity(81);
        for board in (0..9).filter(|&b| self.allowed & 1 << b != 0) {
            let (mine, theirs) = (self.marks[self.turn][board], self.marks[you][board]);
            for cell in (0..9).filter(|&c| self.empty(board) & 1 << c != 0) {
                let mut rank = REACH[cell] / 2;
                if has_line(mine | 1 << cell) {
                    rank += 8; // Wins the board.
                } else if has_line(theirs | 1 << cell) {
                    rank += 4; // Takes the cell that the opponent needs.
                }
                // Sending the opponent to a closed board lets them play anywhere.
                if self.closed & 1 << cell != 0 && cell != board {
                    rank -= 2;
                }
                found.push((rank, board, cell));
            }
        }
        found.sort_by_key(|&(rank, ..)| Reverse(rank));
        found
            .into_iter()
            .map(|(_, board, cell)| (board, cell))
            .collect()
    }

    /// The position after the player to move marks `cell` of `board`.
    fn play(&self, board: usize, cell: usize) -> Self {
        let mut next = *self;
        next.marks[self.turn][board] |= 1 << cell;
        if has_line(next.marks[self.turn][board]) {
            next.won[self.turn] |= 1 << board;
            next.closed |= 1 << board;
        } else if next.empty(board) == 0 {
            next.closed |= 1 << board;
        }
        next.over = if has_line(next.won[self.turn]) {
            Some(Over::Won(self.turn))
        } else if next.closed == FULL {
            Some(Over::Drawn)
        } else {
            None
        };
        // Sent to the board of the cell, or to any that is open if that one is closed.
        next.allowed = if next.closed & 1 << cell == 0 {
            1 << cell
        } else {
            !next.closed & FULL
        };
        next.turn = 1 - self.turn;
        next
    }
}

/// How good a position is for `me`, when the game is not over: higher is better.
fn evaluate(position: &Position, me: usize) -> i32 {
    let you = 1 - me;
    let drawn = position.closed & !position.won[0] & !position.won[1];
    let mut score = 0;

    // The big board: the boards won, and the lines of them that the other player can't block.
    for (board, reach) in REACH.iter().enumerate() {
        let bit = 1u16 << board;
        if position.won[me] & bit != 0 {
            score += BOARD * reach;
        } else if position.won[you] & bit != 0 {
            score -= BOARD * reach;
        }
    }
    for line in MASKS {
        if line & (position.won[you] | drawn) == 0 {
            score += BIG_LINE[(position.won[me] & line).count_ones() as usize];
        }
        if line & (position.won[me] | drawn) == 0 {
            score -= BIG_LINE[(position.won[you] & line).count_ones() as usize];
        }
    }

    // The small boards that are still open: the lines that only one player has marks in. A line
    // with marks of both, or with none, is of no use to anyone. An open board has no line of
    // three, so a player has one or two marks in a line they can still win.
    for board in (0..9).filter(|&b| position.closed & 1 << b == 0) {
        let (mine, theirs) = (position.marks[me][board], position.marks[you][board]);
        for line in MASKS {
            if line & theirs == 0 {
                score += SMALL_LINE[(line & mine).count_ones() as usize] * REACH[board];
            } else if line & mine == 0 {
                score -= SMALL_LINE[(line & theirs).count_ones() as usize] * REACH[board];
            }
        }
    }
    score
}

/// What the search keeps while it works.
struct Search {
    /// How many positions have been looked at.
    nodes: u32,
    /// The budget ran out partway through a round, so the round has no answer.
    out_of_budget: bool,
}

impl Search {
    /// The score of `position` for the player to move, looking `depth` moves ahead. The usual
    /// alpha-beta: the score is exact if it is between `alpha` and `beta`, and otherwise only
    /// says which side of them it is. `ply` is how many moves the search has made already, which
    /// makes a quick win worth more.
    fn negamax(
        &mut self,
        position: &Position,
        depth: u32,
        ply: i32,
        mut alpha: i32,
        beta: i32,
    ) -> i32 {
        let mut best = -WIN - 1;
        for (board, cell) in position.moves() {
            self.nodes += 1;
            if self.nodes > BUDGET {
                self.out_of_budget = true;
                return 0;
            }
            let next = position.play(board, cell);
            let score = match next.over {
                Some(Over::Won(_)) => WIN - ply, // The mover is the only one who can have won.
                Some(Over::Drawn) => 0,
                None if depth <= 1 => evaluate(&next, position.turn),
                None => -self.negamax(&next, depth - 1, ply + 1, -beta, -alpha),
            };
            if self.out_of_budget {
                return 0;
            }
            best = best.max(score);
            alpha = alpha.max(score);
            if alpha >= beta {
                break;
            }
        }
        best
    }
}

/// The moves that the search likes best for the player to move in `state`, equally as far as
/// it can tell. Empty if there is no move.
fn best_moves(state: &State) -> Vec<(usize, usize)> {
    let root = Position::of(state);
    let mut ranked: Vec<((usize, usize), i32)> = root.moves().into_iter().map(|m| (m, 0)).collect();
    let mut best: Vec<(usize, usize)> = ranked.iter().map(|&(m, _)| m).collect();
    let mut search = Search {
        nodes: 0,
        out_of_budget: false,
    };

    // The most moves the game can still last is what deeper rounds are for. A round that finds
    // the game decided is the last one worth playing.
    for depth in 1..=81 {
        let mut round: Vec<((usize, usize), i32)> = Vec::with_capacity(ranked.len());
        let mut top = -WIN - 1;
        for &((board, cell), _) in &ranked {
            let next = root.play(board, cell);
            // The window only keeps out the moves that are worse than the best so far, so that
            // the moves that are equal to it are found exactly, and one can be picked from them.
            let score = match next.over {
                Some(Over::Won(_)) => WIN,
                Some(Over::Drawn) => 0,
                None if depth == 1 => evaluate(&next, root.turn),
                None => -search.negamax(&next, depth - 1, 1, -WIN - 1, -(top - 1)),
            };
            if search.out_of_budget {
                break;
            }
            top = top.max(score);
            round.push(((board, cell), score));
        }
        if search.out_of_budget {
            break;
        }
        best = round
            .iter()
            .filter(|&&(_, score)| score == top)
            .map(|&(m, _)| m)
            .collect();
        // The best first, so that the next round meets the move most likely to prune the others.
        round.sort_by_key(|&(_, score)| Reverse(score));
        ranked = round;
        if top.abs() >= WIN - 81 {
            break;
        }
    }
    best
}

/// The move the hard bot plays in `state`, picked at random among the ones it likes best
/// equally, so that it doesn't play the same game every time.
pub fn choose(state: &State, rng: &mut dyn Random) -> Option<(usize, usize)> {
    let best = best_moves(state);
    best.get(rng.below(best.len())?).copied()
}
