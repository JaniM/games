//! How one player's checkers move in a single turn: what a die may do, and which
//! steps a player may start with once the must-play rules are applied.
//!
//! This is a direct transcription of `docs/games/long-backgammon.md`; its section names
//! are used in the comments. Everything is in the **own index** of the player who moves
//! (points 1 to 24, 1 being the head and 19 to 24 the home), except the opponent's checkers,
//! which are in the opponent's own index. [`across`] converts between the two.
//!
//! Nothing here knows about dice rolls, turns or who has won. A [`Turn`] is the position
//! as one player sees it while playing their dice, and the functions answer questions
//! about it.

use serde::{Deserialize, Serialize};

/// The number of checkers each player has.
pub const CHECKERS: u8 = 15;

/// Checkers by point: the count on own point `i` is at position `i - 1`.
pub type Points = [u8; 24];

/// The first point of the home.
const HOME: u8 = 19;

/// The shortest run of points that is a block (see [`forbidden_block`]).
const BLOCK: usize = 6;

/// The point that a physical point is to the other player: the heads are half a ring apart,
/// so own point `i` is the opponent's `i + 12`, or `i - 12` past 12.
pub const fn across(index: u8) -> u8 {
    if index <= 12 { index + 12 } else { index - 12 }
}

/// One die played by one checker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Step {
    /// The own point the checker leaves.
    pub from: u8,
    /// The die played. The checker lands on `from + die`, or is borne off from 25 on.
    pub die: u8,
}

/// Where a step ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Landing {
    Point(u8),
    Off,
}

/// Why a single step is against the rules, leaving the must-play rules aside.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Illegal {
    /// There is no such point, or no checker of the mover's on it.
    NoChecker,
    /// An opposing checker is on the landing point.
    Blocked { to: u8 },
    /// A checker has already left the head, and the turn doesn't allow another.
    HeadUsed,
    /// The step would make a block with no opposing checker in front of it.
    Prime,
    /// Bearing off needs all of the checkers in the home.
    NotAllHome,
    /// The die is bigger than the checker's distance, and a checker is farther back.
    CheckerFarther,
}

impl Illegal {
    /// For the player who tried it.
    pub fn message(self, step: Step) -> String {
        match self {
            Self::NoChecker => format!("you have no checker on point {}", step.from),
            Self::Blocked { to } => format!("point {to} is held by your opponent"),
            Self::HeadUsed => "only one checker may leave the head each turn".to_owned(),
            Self::Prime => "you can't make six points in a row with no opposing checker \
                            in front of them"
                .to_owned(),
            Self::NotAllHome => "you can bear off only when all your checkers are home".to_owned(),
            Self::CheckerFarther => {
                "this die is too big to bear off from there while you have a checker farther back"
                    .to_owned()
            }
        }
    }
}

/// The position as the player to move sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Turn {
    /// The mover's checkers.
    pub mine: Points,
    /// How many of the mover's checkers are borne off.
    pub off: u8,
    /// The opponent's checkers, in the opponent's own index.
    pub theirs: Points,
    /// How many more checkers may leave the head this turn.
    pub head_left: u8,
}

fn at(points: &Points, index: u8) -> u8 {
    points[usize::from(index) - 1]
}

/// Whether the step is allowed by the rules for a single move, ignoring the must-play
/// rules (which depend on the other dice).
pub fn check(turn: &Turn, step: Step) -> Result<Landing, Illegal> {
    let Step { from, die } = step;
    if !(1..=24).contains(&from) || at(&turn.mine, from) == 0 {
        return Err(Illegal::NoChecker);
    }
    let to = u16::from(from) + u16::from(die);

    if to <= 24 {
        let to = to as u8; // At most 24.
        if at(&turn.theirs, across(to)) > 0 {
            return Err(Illegal::Blocked { to });
        }
        if from == 1 && turn.head_left == 0 {
            return Err(Illegal::HeadUsed);
        }
        let mut after = turn.mine;
        after[usize::from(from) - 1] -= 1;
        after[usize::from(to) - 1] += 1;
        if forbidden_block(&after, &turn.theirs) {
            return Err(Illegal::Prime);
        }
        return Ok(Landing::Point(to));
    }

    // Bearing off. Checkers already off don't count against this.
    if turn.mine[..usize::from(HOME) - 1].iter().any(|&n| n > 0) {
        return Err(Illegal::NotAllHome);
    }
    // 25 is an exact bear-off. Past it the die overshoots, which is allowed only for the
    // farthest checker.
    let farther = &turn.mine[usize::from(HOME) - 1..usize::from(from) - 1];
    if to > 25 && farther.iter().any(|&n| n > 0) {
        return Err(Illegal::CheckerFarther);
    }
    Ok(Landing::Off)
}

/// The position after the step, or why it is against the rules.
pub fn play(turn: &Turn, step: Step) -> Result<Turn, Illegal> {
    let landing = check(turn, step)?;
    let mut next = *turn;
    next.mine[usize::from(step.from) - 1] -= 1;
    match landing {
        Landing::Point(to) => next.mine[usize::from(to) - 1] += 1,
        Landing::Off => next.off += 1,
    }
    if step.from == 1 {
        next.head_left -= 1;
    }
    Ok(next)
}

/// Whether `mine` has a block that no opposing checker is in front of (the prime rule).
///
/// A block is six or more points in a row **in the opponent's path order**: opponent
/// points `k` to `k + 5`, with no wrap from the opponent's 24 to their 1. Opposing checkers
/// are in front of a block if one is on a higher opponent point than the end of the run.
/// Borne-off checkers are not on the board, so they don't count.
pub fn forbidden_block(mine: &Points, theirs: &Points) -> bool {
    let mut run = 0;
    for point in 1..=24u8 {
        // Whether the mover holds the point that the opponent calls `point`.
        let held = |point: u8| at(mine, across(point)) > 0;
        run = if held(point) { run + 1 } else { 0 };
        let ends_here = point == 24 || !held(point + 1);
        // The opponent's points after this one are the tail of their array.
        if run >= BLOCK && ends_here && theirs[usize::from(point)..].iter().all(|&n| n == 0) {
            return true;
        }
    }
    false
}

/// The dice left to play, without the one at `skip`. At most four dice, so no heap.
fn without(dice: &[u8], skip: usize) -> ([u8; 4], usize) {
    let mut rest = [0; 4];
    let mut len = 0;
    for (i, &die) in dice.iter().enumerate() {
        if i != skip {
            rest[len] = die;
            len += 1;
        }
    }
    (rest, len)
}

/// The most dice that can be played from here, in any order.
fn most_playable(turn: &Turn, dice: &[u8]) -> usize {
    let mut best = 0;
    for (i, &die) in dice.iter().enumerate() {
        if dice[..i].contains(&die) {
            continue; // The same die again (a double) leads to the same places.
        }
        let (rest, len) = without(dice, i);
        for from in 1..=24 {
            if let Ok(next) = play(turn, Step { from, die }) {
                best = best.max(1 + most_playable(&next, &rest[..len]));
                if best == dice.len() {
                    return best; // Everything is played; nothing is better.
                }
            }
        }
    }
    best
}

/// The steps the player may start with, given the dice still to play: the single steps
/// that are legal, narrowed by the must-play rules.
///
/// 1. Play as many dice as possible: a step is allowed only if some way of playing on from
///    it plays as many dice as the best way from any step.
/// 2. If no order plays both dice of a roll that isn't a double, but the larger one can be
///    played alone, the larger one must be.
///
/// Sorted by point, then die. Empty if no die can be played.
pub fn legal_steps(turn: &Turn, remaining: &[u8]) -> Vec<Step> {
    let mut candidates: Vec<(Step, usize)> = Vec::new();
    for (i, &die) in remaining.iter().enumerate() {
        if remaining[..i].contains(&die) {
            continue;
        }
        let (rest, len) = without(remaining, i);
        for from in 1..=24 {
            let step = Step { from, die };
            if let Ok(next) = play(turn, step) {
                candidates.push((step, 1 + most_playable(&next, &rest[..len])));
            }
        }
    }
    let Some(best) = candidates.iter().map(|&(_, plays)| plays).max() else {
        return Vec::new();
    };
    candidates.retain(|&(_, plays)| plays == best);

    if let [a, b] = *remaining
        && a != b
        && best == 1
    {
        let larger = a.max(b);
        if candidates.iter().any(|(step, _)| step.die == larger) {
            candidates.retain(|(step, _)| step.die == larger);
        }
    }

    let mut steps: Vec<Step> = candidates.into_iter().map(|(step, _)| step).collect();
    steps.sort();
    steps
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A row of checkers: `(point, count)` pairs, with every other point empty.
    pub fn points(held: &[(u8, u8)]) -> Points {
        let mut points = [0; 24];
        for &(index, count) in held {
            points[usize::from(index) - 1] = count;
        }
        points
    }

    /// A turn with the given checkers and a head allowance of one.
    fn turn(mine: &[(u8, u8)], theirs: &[(u8, u8)]) -> Turn {
        Turn {
            mine: points(mine),
            off: 0,
            theirs: points(theirs),
            head_left: 1,
        }
    }

    fn step(from: u8, die: u8) -> Step {
        Step { from, die }
    }

    /// Both players on their heads: the start of a game.
    fn opening(head_left: u8) -> Turn {
        Turn {
            head_left,
            ..turn(&[(1, 15)], &[(1, 15)])
        }
    }

    #[test]
    fn the_same_physical_point_has_two_indexes() {
        assert_eq!(across(1), 13);
        assert_eq!(across(12), 24);
        assert_eq!(across(13), 1);
        assert_eq!(across(24), 12);
        for index in 1..=24 {
            assert_eq!(across(across(index)), index);
        }
    }

    // --- Legal single move ---

    #[test]
    fn a_die_moves_a_checker_forward_by_that_many_points() {
        let turn = turn(&[(5, 1)], &[(1, 15)]);

        assert_eq!(check(&turn, step(5, 3)), Ok(Landing::Point(8)));
        assert_eq!(play(&turn, step(5, 3)).unwrap().mine, points(&[(8, 1)]));
    }

    #[test]
    fn there_must_be_a_checker_on_the_point() {
        let turn = turn(&[(5, 1)], &[]);

        for from in [0, 4, 25, 200] {
            assert_eq!(
                check(&turn, step(from, 1)),
                Err(Illegal::NoChecker),
                "{from}"
            );
        }
    }

    #[test]
    fn a_point_with_an_opposing_checker_is_blocked() {
        // Own point 13 is the opponent's point 1, their head.
        let turn = turn(&[(10, 1)], &[(1, 15)]);

        assert_eq!(check(&turn, step(10, 3)), Err(Illegal::Blocked { to: 13 }));
        assert_eq!(check(&turn, step(10, 2)), Ok(Landing::Point(12)));
    }

    #[test]
    fn a_die_is_a_single_hop_over_whatever_stands_between() {
        // The opponent holds own points 11 and 12 (their 23 and 24) but not 13.
        let turn = turn(&[(10, 1)], &[(23, 1), (24, 1)]);

        assert_eq!(check(&turn, step(10, 3)), Ok(Landing::Point(13)));
    }

    #[test]
    fn own_checkers_may_share_a_point() {
        let turn = turn(&[(5, 1), (8, 3)], &[]);

        assert_eq!(check(&turn, step(5, 3)), Ok(Landing::Point(8)));
    }

    #[test]
    fn a_checker_never_leaves_the_board_before_the_bear_off() {
        // A checker on 20 with a checker behind it can't use a 6 to leave.
        let turn = turn(&[(10, 1), (20, 1)], &[]);

        assert_eq!(check(&turn, step(20, 6)), Err(Illegal::NotAllHome));
    }

    // --- Head rule ---

    #[test]
    fn one_checker_may_leave_the_head_each_turn() {
        let turn = opening(1);
        let after_one = play(&turn, step(1, 5)).unwrap();

        assert_eq!(after_one.head_left, 0);
        assert_eq!(check(&after_one, step(1, 4)), Err(Illegal::HeadUsed));
    }

    #[test]
    fn a_second_head_checker_is_allowed_when_the_turn_allows_two() {
        let turn = opening(2);
        let after_one = play(&turn, step(1, 4)).unwrap();

        assert_eq!(check(&after_one, step(1, 4)), Ok(Landing::Point(5)));
    }

    // --- Prime rule ---

    /// White-like mover holding own points 14 to 18, about to move 13 to 19: in the
    /// opponent's order that is a block on their points 2 to 7.
    fn prime_turn(theirs: &[(u8, u8)]) -> Turn {
        turn(
            &[(1, 8), (13, 1), (14, 1), (15, 1), (16, 1), (17, 1), (18, 1)],
            theirs,
        )
    }

    #[test]
    fn six_in_a_row_is_forbidden_while_every_opposing_checker_is_behind() {
        let turn = prime_turn(&[(1, 15)]);

        assert_eq!(check(&turn, step(13, 6)), Err(Illegal::Prime));
    }

    #[test]
    fn six_in_a_row_is_allowed_with_an_opposing_checker_in_front() {
        // The block would be the opponent's points 2 to 7. Their point 8 is in front.
        let turn = prime_turn(&[(1, 14), (8, 1)]);

        assert_eq!(check(&turn, step(13, 6)), Ok(Landing::Point(19)));
    }

    #[test]
    fn an_opposing_checker_beside_the_block_is_not_in_front_of_it() {
        // Their point 1 is behind the block, and borne-off checkers aren't on the board.
        let turn = prime_turn(&[(1, 1)]);

        assert_eq!(check(&turn, step(13, 6)), Err(Illegal::Prime));
    }

    #[test]
    fn five_in_a_row_is_fine() {
        let turn = turn(
            &[(1, 9), (13, 1), (14, 1), (15, 1), (16, 1), (17, 1)],
            &[(1, 15)],
        );

        assert_eq!(check(&turn, step(13, 5)), Ok(Landing::Point(18)));
    }

    #[test]
    fn a_run_longer_than_six_is_judged_at_its_last_point() {
        // Own 14 to 20 are the opponent's 2 to 8: seven in a row. Their checker on 9 is in
        // front of it, and one on 1 is behind it. (No checker of theirs can stand inside
        // the run, since the mover holds those points.)
        let mine = points(&[
            (14, 1),
            (15, 1),
            (16, 1),
            (17, 1),
            (18, 1),
            (19, 1),
            (20, 1),
        ]);

        assert!(!forbidden_block(&mine, &points(&[(1, 1), (9, 1)])));
        assert!(forbidden_block(&mine, &points(&[(1, 1)])));
    }

    #[test]
    fn the_run_never_wraps_through_the_opponents_last_point() {
        // Own points 10 to 15 are the opponent's 22, 23, 24, 1, 2, 3: not in a row on their path.
        let mine = points(&[(10, 1), (11, 1), (12, 1), (13, 1), (14, 1), (15, 1)]);

        assert!(!forbidden_block(&mine, &points(&[(5, 1)])));
    }

    #[test]
    fn the_run_does_cross_the_movers_own_wrap() {
        // Own 21, 22, 23, 24, 1, 2 are the opponent's 9, 10, 11, 12, 13, 14.
        let mine = points(&[(21, 1), (22, 1), (23, 1), (24, 1), (1, 1), (2, 1)]);

        assert!(forbidden_block(&mine, &points(&[(5, 1)])));
        assert!(!forbidden_block(&mine, &points(&[(15, 1)])));
    }

    #[test]
    fn a_block_at_the_end_of_the_opponents_path_has_nothing_in_front() {
        // Own 7 to 12 are the opponent's 19 to 24.
        let mine = points(&[(7, 1), (8, 1), (9, 1), (10, 1), (11, 1), (12, 1)]);

        assert!(forbidden_block(&mine, &points(&[(1, 5)])));
        assert!(forbidden_block(&mine, &[0; 24]));
    }

    #[test]
    fn a_bear_off_is_not_judged_by_the_prime_rule() {
        // A bear-off cannot create a block, so it is never checked. Own 19 to 24 are the
        // opponent's 7 to 12, a block with their only checker behind it; this position is
        // not reachable in play and only shows that `check` does not look at it here.
        let turn = turn(
            &[(19, 1), (20, 1), (21, 1), (22, 1), (23, 1), (24, 1)],
            &[(1, 1)],
        );

        assert!(forbidden_block(&turn.mine, &turn.theirs));
        assert_eq!(check(&turn, step(24, 1)), Ok(Landing::Off));
    }

    // --- Bearing off ---

    #[test]
    fn an_exact_die_bears_off() {
        let turn = turn(&[(19, 1), (22, 1)], &[]);

        assert_eq!(check(&turn, step(22, 3)), Ok(Landing::Off));
        assert_eq!(check(&turn, step(19, 6)), Ok(Landing::Off));
        assert_eq!(play(&turn, step(22, 3)).unwrap().off, 1);
    }

    #[test]
    fn a_bigger_die_cannot_bear_off_while_a_checker_is_farther_back() {
        // Worked example 7: checkers on 19 and 22; a 5 can't take 22 off.
        let turn = turn(&[(19, 1), (22, 1)], &[]);

        assert_eq!(check(&turn, step(22, 5)), Err(Illegal::CheckerFarther));
        assert_eq!(legal_steps(&turn, &[5]), vec![step(19, 5)]);
    }

    #[test]
    fn a_bigger_die_bears_off_the_farthest_checker() {
        // Worked example 8: checkers on 21 to 24; a 6 takes off the one on 21.
        let turn = turn(&[(21, 1), (22, 1), (23, 1), (24, 1)], &[]);

        assert_eq!(check(&turn, step(21, 6)), Ok(Landing::Off));
        assert_eq!(check(&turn, step(22, 6)), Err(Illegal::CheckerFarther));
        assert_eq!(legal_steps(&turn, &[6]), vec![step(21, 6)]);
    }

    #[test]
    fn a_die_may_be_played_inside_the_home_instead_of_bearing_off() {
        let turn = turn(&[(19, 1), (22, 1)], &[]);

        assert_eq!(legal_steps(&turn, &[3]), vec![step(19, 3), step(22, 3)]);
    }

    #[test]
    fn bearing_off_waits_for_the_last_checker_to_come_home() {
        let turn = turn(&[(18, 1), (24, 1)], &[]);

        assert_eq!(check(&turn, step(24, 1)), Err(Illegal::NotAllHome));
        assert_eq!(legal_steps(&turn, &[1]), vec![step(18, 1)]);
    }

    #[test]
    fn checkers_already_off_do_not_hold_up_the_bear_off() {
        let mut turn = turn(&[(24, 1)], &[]);
        turn.off = 14;

        assert_eq!(check(&turn, step(24, 1)), Ok(Landing::Off));
    }

    // --- Must-play rules ---

    #[test]
    fn a_step_that_dead_ends_is_not_allowed_when_another_order_plays_both_dice() {
        // Checkers on 10 and 20; the roll is 3-1. The opponent holds own 14 and 21
        // (their 2 and 9). Playing 3 with the checker on 10 leaves no 1 to play, but
        // 1 with it, or 3 with the other checker, plays both.
        let turn = turn(&[(10, 1), (20, 1)], &[(2, 1), (9, 1)]);

        assert_eq!(check(&turn, step(10, 3)), Ok(Landing::Point(13)));
        assert_eq!(legal_steps(&turn, &[3, 1]), vec![step(10, 1), step(20, 3)]);
    }

    #[test]
    fn a_double_plays_as_many_of_the_four_as_it_can() {
        // One checker on 20 and the opponent holding own 24 (their 12): 20, 22 and then stuck.
        let turn = turn(&[(20, 1)], &[(12, 1)]);

        assert_eq!(legal_steps(&turn, &[2, 2, 2, 2]), vec![step(20, 2)]);
        let after = play(&turn, step(20, 2)).unwrap();
        assert_eq!(legal_steps(&after, &[2, 2, 2]), Vec::new());
    }

    #[test]
    fn only_the_larger_die_is_played_if_just_one_can_be() {
        // Worked example 6: one checker on 10 and the opponent holding own 17 (their 5).
        // 10 to 16 to 17 and 10 to 11 to 17 are both blocked.
        let turn = turn(&[(10, 1)], &[(5, 1)]);

        assert_eq!(legal_steps(&turn, &[6, 1]), vec![step(10, 6)]);
        assert_eq!(legal_steps(&turn, &[1, 6]), vec![step(10, 6)]);
    }

    #[test]
    fn the_smaller_die_is_played_if_it_is_the_only_one_that_can_be() {
        // The 6 is blocked outright (own 16 is their 4), the 1 is not.
        let turn = turn(&[(10, 1)], &[(4, 1), (5, 1)]);

        assert_eq!(legal_steps(&turn, &[6, 1]), vec![step(10, 1)]);
    }

    #[test]
    fn no_dice_can_be_played_when_every_landing_point_is_held() {
        // Own 11 to 16 are the opponent's 23, 24, 1, 2, 3, 4.
        let turn = turn(
            &[(10, 15)],
            &[(23, 1), (24, 1), (1, 1), (2, 1), (3, 1), (4, 1)],
        );

        assert_eq!(legal_steps(&turn, &[6, 5]), Vec::new());
    }

    #[test]
    fn any_checker_may_play_either_die_if_both_get_played() {
        let turn = turn(&[(5, 1), (9, 1)], &[]);

        assert_eq!(
            legal_steps(&turn, &[2, 3]),
            vec![step(5, 2), step(5, 3), step(9, 2), step(9, 3)]
        );
    }

    // --- Worked examples from the rules ---

    #[test]
    fn opening_with_six_six_takes_two_checkers_off_the_head_and_loses_the_rest() {
        // Example 1.
        let turn = opening(2);
        assert_eq!(legal_steps(&turn, &[6, 6, 6, 6]), vec![step(1, 6)]);

        let after = play(&turn, step(1, 6)).unwrap();
        assert_eq!(legal_steps(&after, &[6, 6, 6]), vec![step(1, 6)]);

        let after = play(&after, step(1, 6)).unwrap();
        // The checkers on 7 would land on 13, the opponent's head.
        assert_eq!(legal_steps(&after, &[6, 6]), Vec::new());
        assert_eq!(after.mine, points(&[(1, 13), (7, 2)]));
    }

    #[test]
    fn opening_with_four_four_must_take_two_checkers_off_the_head() {
        // Example 2: 1 to 5 to 9 is two moves, since 13 is blocked; two head checkers play four.
        let mut ends = outcomes(&opening(2), &[4, 4, 4, 4]);
        ends.dedup();

        assert_eq!(ends, vec![points(&[(1, 13), (9, 2)])]);
    }

    #[test]
    fn opening_with_five_five_plays_all_four_with_one_checker() {
        // Example 3: one head checker plays 1, 6, 11, 16, 21, so a second one is not allowed.
        let mut ends = outcomes(&opening(1), &[5, 5, 5, 5]);
        ends.dedup();

        assert_eq!(ends, vec![points(&[(1, 14), (21, 1)])]);
    }

    #[test]
    fn a_later_turn_allows_one_head_checker_only() {
        // Example 4: 14 checkers on the head and one on 8, with a roll of 5-4. (8 and 5 would
        // land on 13, the opponent's head.)
        let turn = turn(&[(1, 14), (8, 1)], &[(1, 15)]);
        let first = legal_steps(&turn, &[5, 4]);
        assert_eq!(first, vec![step(1, 4), step(1, 5), step(8, 4)]);

        let after = play(&turn, step(1, 5)).unwrap();
        assert_eq!(legal_steps(&after, &[4]), vec![step(6, 4), step(8, 4)]);
    }

    /// Every position the turn can end in by playing `dice` in any legal way, sorted.
    fn outcomes(turn: &Turn, dice: &[u8]) -> Vec<Points> {
        fn walk(turn: &Turn, dice: &[u8], ends: &mut Vec<Points>) {
            let steps = legal_steps(turn, dice);
            if steps.is_empty() {
                ends.push(turn.mine);
            }
            for step in steps {
                let (rest, len) = without(dice, dice.iter().position(|&d| d == step.die).unwrap());
                walk(&play(turn, step).unwrap(), &rest[..len], ends);
            }
        }
        let mut ends = Vec::new();
        walk(turn, dice, &mut ends);
        ends.sort();
        ends
    }

    // --- A second opinion on the must-play rules ---

    /// Every complete line of play from here, without any must-play filtering: a line is a
    /// list of steps that ends when no die can be played. Plain and slow on purpose.
    fn all_lines(turn: &Turn, dice: &[u8]) -> Vec<Vec<Step>> {
        let mut lines = Vec::new();
        let mut extended = false;
        for (i, &die) in dice.iter().enumerate() {
            if dice[..i].contains(&die) {
                continue; // The same die again (a double) makes the same lines.
            }
            for from in 1..=24 {
                let step = Step { from, die };
                if let Ok(next) = play(turn, step) {
                    extended = true;
                    let rest: Vec<u8> = dice
                        .iter()
                        .enumerate()
                        .filter(|&(j, _)| j != i)
                        .map(|(_, &d)| d)
                        .collect();
                    for mut line in all_lines(&next, &rest) {
                        line.insert(0, step);
                        lines.push(line);
                    }
                }
            }
        }
        if !extended {
            lines.push(Vec::new());
        }
        lines
    }

    /// The legal first steps by their definition in the rules: the first steps of the
    /// longest lines; for a roll that isn't a double and plays only one die, the larger
    /// die if it can be played.
    fn first_steps_by_definition(turn: &Turn, dice: &[u8]) -> Vec<Step> {
        let lines = all_lines(turn, dice);
        let longest = lines.iter().map(Vec::len).max().unwrap();
        if longest == 0 {
            return Vec::new();
        }
        let mut firsts: Vec<Step> = lines
            .iter()
            .filter(|line| line.len() == longest)
            .map(|line| line[0])
            .collect();
        if longest == 1 && dice.len() == 2 && dice[0] != dice[1] {
            let larger = dice[0].max(dice[1]);
            if firsts.iter().any(|step| step.die == larger) {
                firsts.retain(|step| step.die == larger);
            }
        }
        firsts.sort();
        firsts.dedup();
        firsts
    }

    /// A small deterministic generator, so that a failure can be reproduced.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self, below: u64) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) % below
        }
    }

    /// `count` checkers dropped on random points from `low` up.
    fn scatter(rng: &mut Lcg, count: u64, low: u8) -> Points {
        let mut held = [0u8; 24];
        for _ in 0..count {
            let index = low + rng.next(u64::from(25 - low)) as u8;
            held[usize::from(index) - 1] += 1;
        }
        held
    }

    /// A random position: a few checkers of each side, spread over the board, sometimes
    /// all of the mover's in the home.
    fn random_turn(rng: &mut Lcg) -> Turn {
        let home_only = rng.next(3) == 0;
        let mine_count = 2 + rng.next(5);
        let theirs_count = 2 + rng.next(8);
        let mut turn = Turn {
            mine: scatter(rng, mine_count, if home_only { 19 } else { 1 }),
            off: 0,
            theirs: scatter(rng, theirs_count, 1),
            head_left: 1 + rng.next(2) as u8,
        };
        // A checker can't stand where the opponent does.
        for index in 1..=24u8 {
            if at(&turn.theirs, across(index)) > 0 {
                turn.mine[usize::from(index) - 1] = 0;
            }
        }
        turn
    }

    #[test]
    fn the_legal_steps_match_the_definition_on_random_positions() {
        let mut rng = Lcg(7);
        for _ in 0..400 {
            let turn = random_turn(&mut rng);
            let (a, b) = (1 + rng.next(6) as u8, 1 + rng.next(6) as u8);
            let dice: Vec<u8> = if a == b { vec![a; 4] } else { vec![a, b] };

            assert_eq!(
                legal_steps(&turn, &dice),
                first_steps_by_definition(&turn, &dice),
                "{turn:?} with {dice:?}"
            );
        }
    }
}
