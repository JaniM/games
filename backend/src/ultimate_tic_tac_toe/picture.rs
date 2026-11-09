//! The board as an SVG, for the preview of a link to a game (see `preview`).
//!
//! It draws what `frontend/src/ultimateTicTacToe/Board.tsx` and the `.ttt*` rules of
//! `frontend/src/styles.css` draw, in the light palette: the same grid of heavy and light lines,
//! the marks, the big mark that claims a board that is won, the boards the next mark must go in,
//! the cell of the last mark, and the boards of the line that won. The tints are the CSS's
//! `color-mix`, worked out by [`mix`]. What only matters to someone at the board (buttons, focus,
//! motion) is left out. Keep the two in step.

use super::{BoardState, State};

/// A colour, as red, green and blue.
type Rgb = [u8; 3];

// The light palette of `styles.css`.
const BG: Rgb = [0xf6, 0xf4, 0xef];
const FG: Rgb = [0x1d, 0x1b, 0x18];
const LINE: Rgb = [0x8a, 0x83, 0x74];
const ACCENT: Rgb = [0xa4, 0x47, 0x2b];
const MARK_O: Rgb = [0x2c, 0x6e, 0x78];

/// CSS's `color-mix(in srgb, a share%, b)`.
fn mix(a: Rgb, share: u32, b: Rgb) -> Rgb {
    let channel =
        |i: usize| ((u32::from(a[i]) * share + u32::from(b[i]) * (100 - share) + 50) / 100) as u8;
    [channel(0), channel(1), channel(2)]
}

fn hex([r, g, b]: Rgb) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// The board is square, and this many units on a side.
const SIZE: u32 = 600;
/// The heavy lines of the big grid are the gaps between the small boards; the light ones of a
/// small board are the gaps between its cells.
const BIG_GAP: u32 = 6;
const SMALL_GAP: u32 = 2;
const BOARD: u32 = (SIZE - 2 * BIG_GAP) / 3;
const CELL: u32 = (BOARD - 2 * SMALL_GAP) / 3;

#[derive(Clone, Copy, PartialEq)]
enum Mark {
    X,
    O,
}

/// An X or an O in a box of `size` units at (`x`, `y`): the strokes of `Mark.tsx`, which draws
/// them on a grid of 100 by 100 with a line of `stroke` of those.
fn mark(out: &mut String, mark: Mark, (x, y): (f32, f32), size: f32, stroke: f32, opacity: f32) {
    let colour = hex(if mark == Mark::X { FG } else { MARK_O });
    let scale = size / 100.0;
    out.push_str(&format!(
        r#"<g transform="translate({x:.2} {y:.2}) scale({scale:.4})" fill="none" stroke="{colour}" stroke-width="{stroke}" stroke-linecap="round" opacity="{opacity}">"#
    ));
    out.push_str(match mark {
        Mark::X => r#"<path d="M25 25 75 75M75 25 25 75"/>"#,
        Mark::O => r#"<circle cx="50" cy="50" r="26"/>"#,
    });
    out.push_str("</g>");
}

/// The board of `state`, or an empty one for a game that hasn't started.
pub fn picture(state: Option<&State>) -> String {
    let big = hex(mix(FG, 80, BG));
    let small = hex(mix(LINE, 45, BG));
    let tint = mix(ACCENT, 9, BG);
    let mut out = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}"><rect width="{SIZE}" height="{SIZE}" fill="{big}"/>"#
    );

    for board in 0..9usize {
        let x0 = (board % 3) as u32 * (BOARD + BIG_GAP);
        let y0 = (board / 3) as u32 * (BOARD + BIG_GAP);
        let result = state.map_or(BoardState::Open, |state| state.boards[board]);
        // Where the next mark must go, and the boards of the line that won, are tinted.
        let target = state.is_some_and(|state| state.playable.contains(&board));
        let on_line =
            state.is_some_and(|state| state.line.is_some_and(|line| line.contains(&board)));
        let cell_colour = if target || on_line { tint } else { BG };
        // A board that is decided: its own marks step back.
        let faded = if result == BoardState::Open {
            1.0
        } else {
            0.25
        };

        out.push_str(&format!(
            r#"<rect x="{x0}" y="{y0}" width="{BOARD}" height="{BOARD}" fill="{small}"/>"#
        ));
        for cell in 0..9usize {
            let x = x0 + (cell % 3) as u32 * (CELL + SMALL_GAP);
            let y = y0 + (cell / 3) as u32 * (CELL + SMALL_GAP);
            let last = state.is_some_and(|state| {
                state
                    .position
                    .last
                    .is_some_and(|last| last.board == board && last.cell == cell)
            });
            // The cell of the last mark is washed with the accent.
            let fill = hex(if last {
                mix(ACCENT, 18, cell_colour)
            } else {
                cell_colour
            });
            out.push_str(&format!(
                r#"<rect x="{x}" y="{y}" width="{CELL}" height="{CELL}" fill="{fill}"/>"#
            ));
            let seat =
                state.and_then(|state| state.position.cells[board][cell].map(|seat| (state, seat)));
            if let Some((state, seat)) = seat {
                let kind = if seat == state.position.x {
                    Mark::X
                } else {
                    Mark::O
                };
                // A mark fills 72% of its cell, from 14% in, as in `.ttt-cell > .ttt-mark`.
                let size = CELL as f32 * 0.72;
                let inset = CELL as f32 * 0.14;
                mark(
                    &mut out,
                    kind,
                    (x as f32 + inset, y as f32 + inset),
                    size,
                    11.0,
                    faded,
                );
            }
        }
        if target {
            // The frame of the board to play in, as `.ttt-board-target::after`: 2 units inside the
            // edge, in the accent at 70%.
            out.push_str(&format!(
                r#"<rect x="{}" y="{}" width="{}" height="{}" fill="none" stroke="{}" stroke-opacity="0.7" stroke-width="2"/>"#,
                x0 + 1,
                y0 + 1,
                BOARD - 2,
                BOARD - 2,
                hex(ACCENT)
            ));
        }
        if let (Some(state), BoardState::Won { seat }) = (state, result) {
            // The big mark that claims the board, over its cells, as `.ttt-claim`.
            let kind = if seat == state.position.x {
                Mark::X
            } else {
                Mark::O
            };
            let size = BOARD as f32 * 0.84;
            let inset = BOARD as f32 * 0.08;
            mark(
                &mut out,
                kind,
                (x0 as f32 + inset, y0 as f32 + inset),
                size,
                6.0,
                1.0,
            );
        }
    }
    out.push_str("</svg>");
    out
}

#[cfg(test)]
mod tests {
    use resvg::usvg;

    use super::super::{Action, Last, Phase, Position, State};
    use super::*;
    use crate::game::Game;

    fn parses(svg: &str) {
        usvg::Tree::from_str(svg, &usvg::Options::default()).expect("the picture is an SVG");
    }

    /// The marks, which are the only groups.
    fn marks(svg: &str) -> usize {
        svg.matches("<g transform").count()
    }

    /// The frames of the boards the next mark must go in.
    fn frames(svg: &str) -> usize {
        svg.matches(r#"stroke-opacity="0.7""#).count()
    }

    #[test]
    fn a_game_that_has_not_started_is_an_empty_board_with_nothing_to_play_in() {
        let svg = picture(None);

        parses(&svg);
        // The background, nine boards and eighty-one cells.
        assert_eq!(svg.matches("<rect").count(), 1 + 9 + 81);
        assert_eq!(marks(&svg), 0);
        assert_eq!(frames(&svg), 0);
    }

    #[test]
    fn a_mark_has_its_players_colour_and_frames_the_board_it_sends_the_opponent_to() {
        // X (seat 0) marks cell 0 of board 4, which sends O to board 0.
        let state = State::reached(Position::new(0));
        let state = state.act(0, Action::Play { board: 4, cell: 0 }).unwrap();

        let svg = picture(Some(&state));

        parses(&svg);
        assert_eq!(marks(&svg), 1);
        assert!(svg.contains(&hex(FG)), "X is drawn in the colour of text");
        assert!(!svg.contains(&hex(MARK_O)));
        assert_eq!(frames(&svg), 1);
        // The frame is board 0's: the top left, inside its edge.
        assert!(svg.contains(&format!(
            r#"<rect x="1" y="1" width="{}" height="{}""#,
            BOARD - 2,
            BOARD - 2
        )));

        // O answers in cell 3 of board 0, which sends X to board 3: O's mark is the other colour.
        let state = state.act(1, Action::Play { board: 0, cell: 3 }).unwrap();
        let svg = picture(Some(&state));
        assert_eq!(marks(&svg), 2);
        assert!(svg.contains(&hex(MARK_O)));
    }

    #[test]
    fn the_player_who_is_x_is_x_whichever_seat_it_is() {
        // Seat 1 is X here, and moves first.
        let state = State::reached(Position::new(1));
        let state = state.act(1, Action::Play { board: 4, cell: 0 }).unwrap();

        let svg = picture(Some(&state));

        assert!(svg.contains(r#"d="M25 25 75 75M75 25 25 75""#), "an X");
        assert!(!svg.contains("<circle"));
    }

    #[test]
    fn a_board_that_is_won_is_claimed_and_its_own_marks_step_back() {
        // X holds the top row of board 0, and O two cells of board 1. X marked last, in cell 2,
        // which sends O to board 2.
        let mut cells = [[None; 9]; 9];
        cells[0][..3].fill(Some(0));
        cells[1][..2].fill(Some(1));
        let state = State::try_from(Position {
            x: 0,
            cells,
            turn: 1,
            last: Some(Last {
                seat: 0,
                board: 0,
                cell: 2,
            }),
            phase: Phase::Play,
        })
        .unwrap();

        let svg = picture(Some(&state));

        parses(&svg);
        // Five marks of cells and one big one over the board that is won.
        assert_eq!(marks(&svg), 6);
        assert_eq!(svg.matches(r#"stroke-width="6""#).count(), 1);
        assert_eq!(
            svg.matches(r#"opacity="0.25""#).count(),
            3,
            "the won board's marks"
        );
        assert_eq!(
            svg.matches(r#"opacity="1""#).count(),
            3,
            "O's two, and the big one"
        );
        assert_eq!(frames(&svg), 1, "board 2, where O must play");
    }

    #[test]
    fn a_game_that_is_won_tints_the_boards_of_its_line_and_frames_nothing() {
        // X holds the top row of boards 0, 1 and 2; O has eight marks and no line. X marked last.
        let mut cells = [[None; 9]; 9];
        for board in &mut cells[..3] {
            board[..3].fill(Some(0));
        }
        for board in &mut cells[3..7] {
            board[..2].fill(Some(1));
        }
        let state = State::try_from(Position {
            x: 0,
            cells,
            turn: 0,
            last: Some(Last {
                seat: 0,
                board: 2,
                cell: 2,
            }),
            phase: Phase::Over {
                winner: Some(0),
                forfeited: false,
            },
        })
        .unwrap();
        assert_eq!(state.line, Some([0, 1, 2]));

        let svg = picture(Some(&state));

        parses(&svg);
        assert_eq!(frames(&svg), 0);
        // 27 cells of the line, but the one the last mark is in, which has the accent too.
        let tint = hex(mix(ACCENT, 9, BG));
        assert_eq!(svg.matches(&format!(r#"fill="{tint}""#)).count(), 26);
        assert!(svg.contains(&hex(mix(ACCENT, 18, mix(ACCENT, 9, BG)))));
    }

    #[test]
    fn the_tints_are_the_css_colour_mixes() {
        // `--tint` and `--ttt-big` of `styles.css`, as a browser works them out.
        assert_eq!(hex(mix(ACCENT, 9, BG)), "#efe4dd");
        assert_eq!(hex(mix(FG, 80, BG)), "#484643");
    }

    #[test]
    fn the_game_gives_the_picture_for_its_state_and_for_none() {
        let state = State::reached(Position::new(0));

        assert_eq!(
            super::super::UltimateTicTacToe::picture(Some(&state)),
            Some(picture(Some(&state)))
        );
        assert_eq!(
            super::super::UltimateTicTacToe::picture(None),
            Some(picture(None))
        );
    }
}
