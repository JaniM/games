//! The pure rules of Hex, from `docs/games/hex.md`: the board, which cells touch, the mirror that
//! the swap uses, and whether a player's stones connect their edges. Nothing here remembers
//! anything: the game around it is in the parent module.
//!
//! Columns and rows are counted from 0 here (the doc counts rows from 1 and letters the columns):
//! the doc's `a1` is column 0, row 0, and `k11` is column 10, row 10. Each row sits half a cell to
//! the right of the row above it, so the neighbours of `(c, r)` are `(c ± 1, r)`, `(c, r − 1)`,
//! `(c + 1, r − 1)`, `(c − 1, r + 1)` and `(c, r + 1)`.
//!
//! A cell is also a number, `row * 11 + column`, and a set of cells is a [`Bits`]: one bit for
//! each of the 121 cells, which fit in a `u128`. Then the neighbours of a whole set are a few
//! shifts, and so is finding which stones are joined to an edge.

/// Cells on a side.
pub const SIZE: usize = 11;

/// Cells on the board.
pub const CELLS: usize = SIZE * SIZE;

/// The two colours. Red moves first, and owns the top edge (row 0) and the bottom one (row 10);
/// Blue owns the left edge (column 0) and the right one (column 10). A player keeps their colour
/// for the whole game: the swap moves the stone, not the players (D4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Colour {
    Red,
    Blue,
}

impl Colour {
    pub const BOTH: [Colour; 2] = [Colour::Red, Colour::Blue];

    /// 0 for Red and 1 for Blue, to index what is kept by colour.
    pub fn index(self) -> usize {
        match self {
            Colour::Red => 0,
            Colour::Blue => 1,
        }
    }

    /// The colour's two edges.
    pub fn edges(self) -> (Bits, Bits) {
        match self {
            Colour::Red => (ROW_FIRST, ROW_LAST),
            Colour::Blue => (COL_FIRST, COL_LAST),
        }
    }
}

/// A set of cells: bit `row * 11 + column` is the cell in that row and column.
pub type Bits = u128;

/// Every cell of the board.
pub const ALL: Bits = (1 << CELLS) - 1;

/// The cells of the top row, Red's first edge.
pub const ROW_FIRST: Bits = (1 << SIZE) - 1;

/// The cells of the bottom row, Red's other edge.
pub const ROW_LAST: Bits = ROW_FIRST << (SIZE * (SIZE - 1));

/// The cells of the left column, Blue's first edge.
pub const COL_FIRST: Bits = {
    let mut bits = 0;
    let mut row = 0;
    while row < SIZE {
        bits |= 1 << (row * SIZE);
        row += 1;
    }
    bits
};

/// The cells of the right column, Blue's other edge.
pub const COL_LAST: Bits = COL_FIRST << (SIZE - 1);

/// The number of the cell in `column` and `row`.
pub const fn index(column: usize, row: usize) -> usize {
    row * SIZE + column
}

/// The column and row of cell number `cell`.
pub const fn place(cell: usize) -> (usize, usize) {
    (cell % SIZE, cell / SIZE)
}

/// The cell across the long diagonal, which runs from `a1` to `k11`: column and row trade places.
/// It is where the swap puts Blue's stone (D4). A cell on the diagonal is its own mirror.
pub const fn mirror(cell: usize) -> usize {
    let (column, row) = place(cell);
    index(row, column)
}

/// The cells that touch any cell of `set`, and that are not in it themselves unless they also touch
/// another cell of it.
pub const fn around(set: Bits) -> Bits {
    // Along the row, the cell that leaves the row on one end would come back on the other, a row
    // up or down: a shift that moves a cell left can't land in the last column, and one that moves
    // it right can't land in the first.
    let left = (set >> 1) & !COL_LAST;
    let right = (set << 1) & !COL_FIRST;
    let up = set >> SIZE;
    let down = set << SIZE;
    let up_right = (set >> (SIZE - 1)) & !COL_FIRST;
    let down_left = (set << (SIZE - 1)) & !COL_LAST;
    (left | right | up | down | up_right | down_left) & ALL
}

/// The cells of `within` that `seed` reaches by steps from one cell to a neighbour, never leaving
/// `within`. Only the cells of `seed` that are in `within` count as a start.
pub fn flood(seed: Bits, within: Bits) -> Bits {
    let mut reached = seed & within;
    loop {
        let next = reached | (around(reached) & within);
        if next == reached {
            return reached;
        }
        reached = next;
    }
}

/// The stones of `stones` that are joined to the first edge of `colour` by a chain of them.
pub fn from_first_edge(stones: Bits, colour: Colour) -> Bits {
    let (first, _) = colour.edges();
    flood(first & stones, stones)
}

/// Whether `stones`, which are `colour`'s, have connected `colour`'s two edges.
pub fn connected(stones: Bits, colour: Colour) -> bool {
    let (_, last) = colour.edges();
    from_first_edge(stones, colour) & last != 0
}

/// The chains of `stones` (`colour`'s) that have a stone on each of `colour`'s edges, or nothing if
/// none does. A game is over as soon as there is one, and only the stone that made it can have, so
/// in a game there is never more than one.
pub fn winning_chain(stones: Bits, colour: Colour) -> Bits {
    let (_, last) = colour.edges();
    flood(from_first_edge(stones, colour) & last, stones)
}

/// The cells of a set, lowest number first, which is reading order: row by row, left to right.
pub fn cells_of(set: Bits) -> impl Iterator<Item = usize> {
    let mut rest = set;
    std::iter::from_fn(move || {
        if rest == 0 {
            return None;
        }
        let cell = rest.trailing_zeros() as usize;
        rest &= rest - 1;
        Some(cell)
    })
}

/// The bit of one cell.
pub const fn bit(cell: usize) -> Bits {
    1 << cell
}
