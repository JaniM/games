//! The board as an SVG, for the preview of a link to a game (see `preview`).
//!
//! It draws what `frontend/src/hex/Board.tsx` and `frontend/src/hex/geometry.ts` draw, with the
//! colours of `frontend/src/styles/hex.css`: the same rhombus of wooden cells with `a1` at the top
//! left, the edges in the colour of the player who owns them, the stones, the dot on the last one, and
//! the winning chain, whose stones stay bright while the others step back. What only matters to
//! someone at the board (buttons, focus, motion) is left out. Keep the two in step.
//!
//! It is drawn in the dark colours of the site, not the light ones, as every game's picture is.

use super::{Phase, State, rules::SIZE};

/// A colour, as red, green and blue.
type Rgb = [u8; 3];

// The dark palette of `styles/tokens.css`, the `prefers-color-scheme: dark` one: the page, the
// walnut of the board and its lines, and the lighter stones that go with it.
const BG: Rgb = [0x16, 0x14, 0x0f];
const WOOD: Rgb = [0x5e, 0x46, 0x32];
const GRAIN: Rgb = [0x3b, 0x2b, 0x1e];
const RED: Rgb = [0xe5, 0x53, 0x4b];
const BLUE: Rgb = [0x5b, 0x8f, 0xd9];

/// CSS's `color-mix(in srgb, a share%, b)`.
fn mix(a: Rgb, share: u32, b: Rgb) -> Rgb {
    let channel =
        |i: usize| ((u32::from(a[i]) * share + u32::from(b[i]) * (100 - share) + 50) / 100) as u8;
    [channel(0), channel(1), channel(2)]
}

fn hex([r, g, b]: Rgb) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// The board's measures, as in `geometry.ts`: a cell's corners are this far from its centre.
pub const RADIUS: f64 = 20.0;
/// How far the coloured edges reach out beyond the cells.
pub const BORDER: f64 = 10.0;
/// What a stone's radius is of a cell's.
const STONE: f64 = 0.74;
/// What the last stone's dot's radius is of a cell's.
const DOT: f64 = 0.22;

const SQRT_3: f64 = 1.732_050_807_568_877_2;
/// A cell's width, from one flat side to the other.
const WIDTH: f64 = RADIUS * SQRT_3;
/// How far the rhombus that the edges are drawn on reaches beyond the centres of the outer cells.
const REACH: f64 = RADIUS + BORDER;
/// How far the centre of `a1` is from the left and the top of the picture.
const LEFT: f64 = SQRT_3 * REACH;
const TOP: f64 = REACH;

/// The picture's width and height. The rows of a cell's centres are 1.5 radii apart, and each is
/// half a cell to the right of the one above.
pub fn size() -> (f64, f64) {
    let span = (SIZE - 1) as f64;
    (
        WIDTH * span * 1.5 + 2.0 * LEFT,
        RADIUS * span * 1.5 + 2.0 * TOP,
    )
}

/// The centre of the cell in `column` and `row`.
pub fn centre(column: usize, row: usize) -> (f64, f64) {
    (
        LEFT + WIDTH * (column as f64 + row as f64 / 2.0),
        TOP + 1.5 * RADIUS * row as f64,
    )
}

/// The corners of the rhombus the edges are drawn on: by `a1`, `k1`, `k11` and `a11`. The two
/// acute ones reach further out, along the long diagonal.
pub fn corners() -> [(f64, f64); 4] {
    let (width, height) = size();
    let span = WIDTH * (SIZE - 1) as f64;
    // Out from the centres of the obtuse corners' cells, along the short diagonal.
    let side = REACH / SQRT_3;
    [
        (0.0, 0.0),
        (LEFT + span + side, 0.0),
        (width, height),
        (LEFT + span / 2.0 - side, height),
    ]
}

/// The six corners of the cell around `(x, y)`, its point at the top.
fn hexagon((x, y): (f64, f64)) -> String {
    (0..6)
        .map(|i| {
            let angle = std::f64::consts::FRAC_PI_3 * i as f64 - std::f64::consts::FRAC_PI_2;
            format!(
                "{:.2},{:.2}",
                x + RADIUS * angle.cos(),
                y + RADIUS * angle.sin()
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn points(points: &[(f64, f64)]) -> String {
    points
        .iter()
        .map(|(x, y)| format!("{x:.2},{y:.2}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The board of `state`, or an empty one for a game that hasn't started.
pub fn picture(state: Option<&State>) -> String {
    let (width, height) = size();
    let [a1, k1, k11, a11] = corners();
    let middle = (width / 2.0, height / 2.0);
    let red_edge = hex(mix(RED, 85, BG));
    let blue_edge = hex(mix(BLUE, 85, BG));
    let mut out = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0}" height="{height:.0}" viewBox="0 0 {width:.2} {height:.2}">"#
    );
    // The rhombus in four, from its middle: Red's on top and below, Blue's on the left and right.
    // The cells cover all of it but the edges.
    for (from, to, colour) in [
        (a1, k1, &red_edge),
        (k1, k11, &blue_edge),
        (k11, a11, &red_edge),
        (a11, a1, &blue_edge),
    ] {
        out.push_str(&format!(
            r#"<polygon points="{}" fill="{colour}"/>"#,
            points(&[from, to, middle])
        ));
    }

    let cell = hex(WOOD);
    let grid = hex(GRAIN);
    for row in 0..SIZE {
        for column in 0..SIZE {
            out.push_str(&format!(
                r#"<polygon points="{}" fill="{cell}" stroke="{grid}" stroke-width="1.5"/>"#,
                hexagon(centre(column, row))
            ));
        }
    }

    let Some(state) = state else {
        out.push_str("</svg>");
        return out;
    };
    let position = &state.position;
    // A game that was won by a connection shows the chain: the other stones step back.
    let chain = state.chain.as_ref();
    let won = matches!(
        position.phase,
        Phase::Over {
            forfeited: false,
            ..
        }
    );
    for (cell, seat) in position.cells.iter().enumerate() {
        let Some(seat) = *seat else { continue };
        let (column, row) = (cell % SIZE, cell / SIZE);
        let colour = hex(if seat == position.red { RED } else { BLUE });
        let on_chain = chain.is_some_and(|chain| {
            chain
                .iter()
                .any(|cell| cell.column == column && cell.row == row)
        });
        // As `.hex-stone-faded`: back, but still plainly the colour it is.
        let opacity = if won && !on_chain { 0.6 } else { 1.0 };
        let (x, y) = centre(column, row);
        out.push_str(&format!(
            r#"<circle cx="{x:.2}" cy="{y:.2}" r="{:.2}" fill="{colour}" stroke="{grid}" stroke-width="1.5" opacity="{opacity}"/>"#,
            RADIUS * STONE
        ));
    }
    if let Some(last) = position.last {
        let (x, y) = centre(last.column, last.row);
        out.push_str(&format!(
            r#"<circle cx="{x:.2}" cy="{y:.2}" r="{:.2}" fill="{cell}"/>"#,
            RADIUS * DOT
        ));
    }
    out.push_str("</svg>");
    out
}

#[cfg(test)]
mod tests {
    use resvg::usvg;

    use super::super::{Action, Hex, Position, rules::CELLS};
    use super::*;
    use crate::game::Game;

    fn parses(svg: &str) {
        usvg::Tree::from_str(svg, &usvg::Options::default()).expect("the picture is an SVG");
    }

    fn stones(svg: &str) -> usize {
        svg.matches(&format!(r#"r="{:.2}""#, RADIUS * STONE))
            .count()
    }

    fn play(state: &State, moves: &[Action]) -> State {
        moves.iter().fold(state.clone(), |state, &action| {
            state.act(state.position.turn, action).unwrap()
        })
    }

    #[test]
    fn a_game_that_has_not_started_is_an_empty_board_with_its_edges() {
        let svg = picture(None);

        parses(&svg);
        // The four parts of the edges and the 121 cells.
        assert_eq!(svg.matches("<polygon").count(), 4 + CELLS);
        assert_eq!(stones(&svg), 0);
        assert_eq!(svg.matches(&hex(mix(RED, 85, BG))).count(), 2);
        assert_eq!(svg.matches(&hex(mix(BLUE, 85, BG))).count(), 2);
    }

    #[test]
    fn the_board_is_as_wide_as_its_rhombus_and_every_cell_is_inside_it() {
        let (width, height) = size();
        // A rhombus of 60 degrees is the square root of three times as wide as it is tall.
        assert!((width / height - SQRT_3).abs() < 1e-9);
        for row in 0..SIZE {
            for column in 0..SIZE {
                let (x, y) = centre(column, row);
                assert!(x - WIDTH / 2.0 > 0.0 && x + WIDTH / 2.0 < width);
                assert!(y - RADIUS > 0.0 && y + RADIUS < height);
            }
        }
        // The corners of the rhombus are beyond the corner cells, by the same distance from each
        // side of it.
        let [a1, k1, k11, a11] = corners();
        assert!((a1.1 - k1.1).abs() < 1e-9 && (k11.1 - a11.1).abs() < 1e-9);
        assert!(((k1.0 - a1.0) - (k11.0 - a11.0)).abs() < 1e-9);
    }

    #[test]
    fn a_stone_has_its_players_colour_and_the_last_one_has_a_dot() {
        // Seat 1 is Red here.
        let state = State::reached(Position::new(1));
        let state = play(&state, &[Action::Place { column: 5, row: 5 }]);

        let svg = picture(Some(&state));

        parses(&svg);
        assert_eq!(stones(&svg), 1);
        assert!(svg.contains(&format!(r#"fill="{}""#, hex(RED))));
        assert!(!svg.contains(&format!(r#"fill="{}""#, hex(BLUE))));
        let dot = format!(r#"r="{:.2}" fill="{}""#, RADIUS * DOT, hex(WOOD));
        assert_eq!(svg.matches(&dot).count(), 1);

        // Blue answers, and the dot moves to Blue's stone.
        let state = play(&state, &[Action::Place { column: 0, row: 0 }]);
        let svg = picture(Some(&state));
        assert_eq!(stones(&svg), 2);
        assert!(svg.contains(&format!(r#"fill="{}""#, hex(BLUE))));
        let (x, y) = centre(0, 0);
        assert!(svg.contains(&format!(
            r#"<circle cx="{x:.2}" cy="{y:.2}" r="{:.2}""#,
            RADIUS * DOT
        )));
    }

    #[test]
    fn a_game_won_by_a_chain_keeps_its_stones_bright_and_the_others_step_back() {
        // Red (seat 0) fills column f, and Blue the first ten cells of column a.
        let mut state = State::reached(Position::new(0));
        for row in 0..SIZE {
            state = play(&state, &[Action::Place { column: 5, row }]);
            if row < SIZE - 1 {
                state = play(&state, &[Action::Place { column: 0, row }]);
            }
        }
        assert!(Hex::is_over(&state));

        let svg = picture(Some(&state));

        parses(&svg);
        assert_eq!(svg.matches(r#"opacity="1""#).count(), SIZE);
        assert_eq!(svg.matches(r#"opacity="0.6""#).count(), SIZE - 1);
    }

    #[test]
    fn a_forfeit_leaves_every_stone_bright() {
        let state = play(
            &State::reached(Position::new(0)),
            &[Action::Place { column: 5, row: 5 }],
        );
        let state = state.forfeit(0).unwrap();

        let svg = picture(Some(&state));

        assert_eq!(svg.matches(r#"opacity="0.6""#).count(), 0);
        assert_eq!(stones(&svg), 1);
    }

    #[test]
    fn the_colours_are_the_css_colour_mixes() {
        // The edges in the dark colours, as a browser works them out.
        assert_eq!(hex(mix(RED, 85, BG)), "#c64a42");
        assert_eq!(hex(mix(BLUE, 85, BG)), "#517dbb");
    }

    #[test]
    fn the_game_gives_the_picture_for_its_state_and_for_none() {
        let state = State::reached(Position::new(0));

        assert_eq!(Hex::picture(Some(&state)), Some(picture(Some(&state))));
        assert_eq!(Hex::picture(None), Some(picture(None)));
    }
}
