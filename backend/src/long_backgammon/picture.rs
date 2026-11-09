//! The board as an SVG, for the preview of a link to a game (see `preview`).
//!
//! It draws what `frontend/src/longBackgammon/Board.tsx` and `Dice.tsx` draw, from the places
//! in `geometry.ts` and `layout.ts`, in the light palette of `styles.css`: the frame, the points,
//! the checkers, the trays with what is borne off, and the dice. The board is seen from seat 0's
//! side, whose head is top right and home bottom right (see `layout.ts`'s `pointSlot`). What only
//! matters to someone at the board (the moves they may make, motion) is left out, and so is the
//! number a stack of more than five checkers shows: the SVG is rendered without text. Keep this in
//! step with the frontend.

use super::{Phase, State};

// The light palette of `styles.css`.
const FRAME: &str = "#6f5238";
const BAR: &str = "#4f3a27";
const TRI_A: &str = "#e4d3b4";
const TRI_B: &str = "#a8704c";
const BOARD_TEXT: &str = "#efe3cc";
const CHECKER_WHITE: (&str, &str) = ("#fbf8f0", "#3a2f22");
const CHECKER_BLACK: (&str, &str) = ("#2a2622", "#0e0c0a");

// Where things are, in the board's own units: `geometry.ts`.
const WIDTH: u32 = 720;
const HEIGHT: u32 = 520;
const MARGIN: u32 = 12;
const POINT_WIDTH: u32 = 48;
const BAR_WIDTH: u32 = 28;
const TOP: u32 = 28;
const BOTTOM: u32 = HEIGHT - 28;
const POINT_HEIGHT: u32 = 170;
const RADIUS: f32 = 19.0;
const STACK_STEP: f32 = 34.0;
const MAX_STACK: usize = 5;
const TRAY_X: u32 = 628;
const TRAY_WIDTH: u32 = 80;
const SLAB_HEIGHT: u32 = 10;
const SLAB_STEP: u32 = 11;
const DIE_SIZE: f32 = 44.0;
const DIE_GAP: f32 = 14.0;
/// Where the dice are thrown: the middle strip between the rows of points, in the right half.
const DICE_CENTRE: (f32, f32) = (
    (MARGIN + 6 * POINT_WIDTH + BAR_WIDTH + 6 * POINT_WIDTH / 2) as f32,
    (TOP + POINT_HEIGHT + 38) as f32,
);
// Dice in a perfectly straight row look placed, not thrown.
const TILTS: [i32; 4] = [-8, 6, -4, 9];
const DRIFTS: [f32; 4] = [-4.0, 5.0, 3.0, -5.0];

/// Pip centres on a 24 by 24 face, by die value: `PIPS` in `Dice.tsx`.
fn pips(value: u8) -> &'static [(f32, f32)] {
    match value {
        1 => &[(12.0, 12.0)],
        2 => &[(7.0, 7.0), (17.0, 17.0)],
        3 => &[(7.0, 7.0), (12.0, 12.0), (17.0, 17.0)],
        4 => &[(7.0, 7.0), (17.0, 7.0), (7.0, 17.0), (17.0, 17.0)],
        5 => &[
            (7.0, 7.0),
            (17.0, 7.0),
            (12.0, 12.0),
            (7.0, 17.0),
            (17.0, 17.0),
        ],
        6 => &[
            (7.0, 6.5),
            (17.0, 6.5),
            (7.0, 12.0),
            (17.0, 12.0),
            (7.0, 17.5),
            (17.0, 17.5),
        ],
        _ => &[],
    }
}

/// How far apart `count` checkers on a point are: `stackStep` in `geometry.ts`.
fn stack_step(count: usize) -> f32 {
    if count <= MAX_STACK {
        STACK_STEP
    } else {
        (MAX_STACK - 1) as f32 * STACK_STEP / (count - 1) as f32
    }
}

/// The point at the same place for the other player: `otherIndex` in `layout.ts`.
fn other_index(k: usize) -> usize {
    if k <= 12 { k + 12 } else { k - 12 }
}

/// A die that was thrown and whether it has been played this turn: `diceFaces` in `layout.ts`.
struct Die {
    value: u8,
    used: bool,
}

fn dice(state: &State) -> Vec<Die> {
    let face = |value, used| Die { value, used };
    match &state.position.phase {
        Phase::Move {
            dice: [a, b],
            remaining,
            ..
        } => {
            if a == b {
                let used = 4usize.saturating_sub(remaining.len());
                (0..4).map(|i| face(*a, i < used)).collect()
            } else {
                // A die is played once, so a die that is among those left is not used.
                let mut left = remaining.clone();
                [*a, *b]
                    .into_iter()
                    .map(|value| match left.iter().position(|&die| die == value) {
                        Some(at) => {
                            left.remove(at);
                            face(value, false)
                        }
                        None => face(value, true),
                    })
                    .collect()
            }
        }
        _ => match &state.position.last_turn {
            Some(last) => {
                let [a, b] = last.dice;
                let values = if a == b { vec![a; 4] } else { vec![a, b] };
                values.into_iter().map(|value| face(value, true)).collect()
            }
            None => Vec::new(),
        },
    }
}

/// The board of `state`, or the starting position for a game that hasn't started.
pub fn picture(state: Option<&State>) -> String {
    // Seat 0 is the viewer. Nobody is White before the start, so seat 0 stands in, as on the
    // page (`colourOf`).
    let white = state.map_or(0, |state| state.position.white);
    let colour = |seat: usize| {
        if seat == white {
            CHECKER_WHITE
        } else {
            CHECKER_BLACK
        }
    };
    let count_on = |seat: usize, k: usize| match state {
        Some(state) => usize::from(state.position.points[seat][k - 1]),
        // Both players' fifteen checkers are on their own heads.
        None => {
            if k == 1 {
                15
            } else {
                0
            }
        }
    };

    let mut out = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}">"#
    );
    out.push_str(&format!(
        r#"<rect width="{WIDTH}" height="{HEIGHT}" rx="4" fill="{FRAME}"/>"#
    ));
    // A fine line inside the edge, as on a made board.
    out.push_str(&format!(
        r#"<rect x="6" y="6" width="{}" height="{}" rx="2" fill="none" stroke="{BOARD_TEXT}" stroke-opacity="0.18"/>"#,
        WIDTH - 12,
        HEIGHT - 12
    ));
    out.push_str(&format!(
        r#"<rect x="{}" y="{}" width="{BAR_WIDTH}" height="{}" fill="{BAR}"/>"#,
        MARGIN + 6 * POINT_WIDTH,
        TOP - 10,
        HEIGHT - 2 * (TOP - 10)
    ));

    for k in 1..=24usize {
        // Point `k` as seat 0 counts it: 1 to 12 along the top from the right, 13 to 24 along
        // the bottom from the left (`pointSlot`).
        let top = k <= 12;
        let column = if top { 12 - k } else { k - 13 } as u32;
        let x = MARGIN + column * POINT_WIDTH + if column >= 6 { BAR_WIDTH } else { 0 };
        let (base, direction) = if top { (TOP, 1.0) } else { (BOTTOM, -1.0) };
        let tip = base as f32 + direction * POINT_HEIGHT as f32;
        let shade = if (column + u32::from(!top)).is_multiple_of(2) {
            TRI_A
        } else {
            TRI_B
        };
        out.push_str(&format!(
            r#"<path d="M{x},{base} L{},{base} L{},{tip} Z" fill="{shade}"/>"#,
            x + POINT_WIDTH,
            x + POINT_WIDTH / 2,
        ));

        // A point never holds both players' checkers.
        let (seat, count) = match (count_on(0, k), count_on(1, other_index(k))) {
            (mine, _) if mine > 0 => (0, mine),
            (_, theirs) => (1, theirs),
        };
        let (fill, stroke) = colour(seat);
        let step = stack_step(count);
        for slot in 0..count {
            let cy = base as f32 + direction * (RADIUS + 2.0 + slot as f32 * step);
            out.push_str(&format!(
                r#"<circle cx="{}" cy="{cy:.2}" r="{RADIUS}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>"#,
                x + POINT_WIDTH / 2
            ));
        }
    }

    // The trays. Seat 1's is top right and seat 0's bottom right; borne-off checkers lie flat,
    // stacked from the far end.
    for (seat, top) in [(1usize, true), (0, false)] {
        let y = if top { TOP } else { BOTTOM - POINT_HEIGHT };
        out.push_str(&format!(
            r#"<rect x="{TRAY_X}" y="{y}" width="{TRAY_WIDTH}" height="{POINT_HEIGHT}" rx="4" fill="{BAR}" stroke="{BOARD_TEXT}" stroke-opacity="0.25"/>"#
        ));
        let (fill, stroke) = colour(seat);
        let off = state.map_or(0, |state| u32::from(state.position.off[seat]));
        for slot in 0..off {
            let slab = if top {
                y + 4 + slot * SLAB_STEP
            } else {
                y + POINT_HEIGHT - 4 - SLAB_HEIGHT - slot * SLAB_STEP
            };
            out.push_str(&format!(
                r#"<rect x="{}" y="{slab}" width="{}" height="{SLAB_HEIGHT}" rx="3" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>"#,
                TRAY_X + 12,
                TRAY_WIDTH - 24
            ));
        }
    }

    if let Some(state) = state {
        let faces = dice(state);
        let width = faces.len() as f32 * DIE_SIZE + faces.len().saturating_sub(1) as f32 * DIE_GAP;
        for (i, Die { value, used }) in faces.iter().enumerate() {
            let x = DICE_CENTRE.0 - width / 2.0 + DIE_SIZE / 2.0 + i as f32 * (DIE_SIZE + DIE_GAP);
            let y = DICE_CENTRE.1 + DRIFTS[i % DRIFTS.len()];
            let tilt = TILTS[i % TILTS.len()];
            // A die that has been played is dimmed.
            let opacity = if *used { 0.3 } else { 1.0 };
            out.push_str(&format!(
                r##"<g transform="translate({x:.2} {y:.2}) rotate({tilt}) translate({half} {half}) scale({scale:.4})" opacity="{opacity}"><rect x="1.5" y="1.5" width="21" height="21" rx="4" fill="#fffdf9" stroke="#3a2f22" stroke-width="1.2"/>"##,
                half = -DIE_SIZE / 2.0,
                scale = DIE_SIZE / 24.0,
            ));
            for (cx, cy) in pips(*value) {
                out.push_str(&format!(
                    r##"<circle cx="{cx}" cy="{cy}" r="2" fill="#1d1b18"/>"##
                ));
            }
            out.push_str("</g>");
        }
    }
    out.push_str("</svg>");
    out
}

#[cfg(test)]
mod tests {
    use resvg::usvg;

    use super::super::{Action, LongBackgammon, Position, State};
    use super::*;
    use crate::game::Game;

    fn parses(svg: &str) {
        usvg::Tree::from_str(svg, &usvg::Options::default()).expect("the picture is an SVG");
    }

    /// The checkers on the points and the pips of the dice are the circles.
    fn circles(svg: &str) -> usize {
        svg.matches("<circle").count()
    }

    /// The dice, which are the only groups.
    fn dice_drawn(svg: &str) -> usize {
        svg.matches("<g transform").count()
    }

    /// White (seat 0) has the move, and has rolled `dice`.
    fn rolled(dice: [u8; 2]) -> State {
        State::reached(Position::new(0).rolled(dice))
    }

    #[test]
    fn a_game_that_has_not_started_has_every_checker_on_its_head_and_no_dice() {
        let svg = picture(None);

        parses(&svg);
        assert_eq!(circles(&svg), 30);
        assert_eq!(dice_drawn(&svg), 0);
        // Seat 0's head is top right and the opponent's, which is point 13 to seat 0, is bottom
        // left: a column of fifteen at each.
        assert_eq!(svg.matches(r#"cx="592""#).count(), 15);
        assert_eq!(svg.matches(r#"cx="36""#).count(), 15);
    }

    #[test]
    fn white_is_the_light_checker_whichever_seat_it_is() {
        let light = format!(r#"fill="{}""#, CHECKER_WHITE.0);
        let dark = format!(r#"fill="{}""#, CHECKER_BLACK.0);

        let seat_0 = picture(Some(&State::reached(Position::new(0))));
        let seat_1 = picture(Some(&State::reached(Position::new(1))));

        // Seat 0 is at the top right (cx 592). It is White in the first game, Black in the second.
        let top_right =
            |svg: &str, fill: &str| svg.contains(&format!(r#"cx="592" cy="49.00" r="19" {fill}"#));
        assert!(top_right(&seat_0, &light));
        assert!(top_right(&seat_1, &dark));
    }

    #[test]
    fn a_roll_shows_its_dice_and_a_die_that_is_played_is_dimmed() {
        let state = rolled([3, 5]);
        let before = picture(Some(&state));
        let state = state
            .act(0, Action::Move { from: 1, die: 3 }, || None)
            .unwrap();
        let after = picture(Some(&state));

        parses(&before);
        parses(&after);
        // Two dice with three and five pips on the checkers' thirty circles.
        assert_eq!(dice_drawn(&before), 2);
        assert_eq!(circles(&before), 30 + 3 + 5);
        assert_eq!(before.matches(r#"opacity="0.3""#).count(), 0);
        assert_eq!(dice_drawn(&after), 2);
        assert_eq!(after.matches(r#"opacity="0.3""#).count(), 1);
    }

    #[test]
    fn a_double_shows_four_dice() {
        let svg = picture(Some(&rolled([4, 4])));

        assert_eq!(dice_drawn(&svg), 4);
    }

    #[test]
    fn the_dice_of_the_turn_that_ended_are_shown_dimmed_while_the_next_player_has_to_roll() {
        // Seat 0 rolls a three and a two and plays both, which ends the turn.
        let state = rolled([3, 2]);
        let state = state
            .act(0, Action::Move { from: 1, die: 3 }, || None)
            .unwrap();
        let state = state
            .act(0, Action::Move { from: 4, die: 2 }, || None)
            .unwrap();

        let svg = picture(Some(&state));

        assert_eq!(dice_drawn(&svg), 2);
        assert_eq!(svg.matches(r#"opacity="0.3""#).count(), 2);
    }

    #[test]
    fn a_checker_borne_off_lies_in_its_players_tray() {
        let mut position = Position::new(0);
        position.points[0][0] = 14;
        position.off[0] = 1;
        let state = State::reached(position);

        let svg = picture(Some(&state));

        parses(&svg);
        assert_eq!(circles(&svg), 14 + 15);
        // The tray of seat 0 is the lower one, and its slab is the only rect with rounded
        // corners of 3.
        assert_eq!(svg.matches(r#"rx="3""#).count(), 1);
    }

    #[test]
    fn a_stack_of_more_than_five_checkers_is_squeezed_to_the_height_of_five() {
        // A stack of 15 on the head: the top one is where the fifth of a short stack would be.
        let svg = picture(Some(&State::reached(Position::new(0))));

        let highest = svg.matches(r#"cx="592" cy=""#).count();
        assert_eq!(highest, 15);
        assert!(
            svg.contains(r#"cx="592" cy="49.00""#),
            "the first, at the base"
        );
        assert!(
            svg.contains(r#"cx="592" cy="185.00""#),
            "the last, 4 steps of 34 up"
        );
    }

    #[test]
    fn the_game_gives_the_picture_for_its_state_and_for_none() {
        let state = State::reached(Position::new(0));

        assert_eq!(
            LongBackgammon::picture(Some(&state)),
            Some(picture(Some(&state)))
        );
        assert_eq!(LongBackgammon::picture(None), Some(picture(None)));
    }
}
