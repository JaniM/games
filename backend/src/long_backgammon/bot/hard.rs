//! How the hard bot of long backgammon chooses a step: it plays a whole turn at a time.
//!
//! The medium bot scores the position after one step, so it can't tell that a step is the first
//! half of a good turn, or the first half of a bad one. This one works out every way the rest of
//! the turn can be played (the steps of `rules::legal_steps`, so the must-play rules and the head
//! and prime rules hold), scores the position each of them ends in ([`evaluate`]), and plays the
//! first step of the best one. It keeps nothing between steps: the next step looks at the turn
//! that is left and arrives at the same plan.
//!
//! The score is a sum of a few things that matter in a game where nothing can be hit:
//!
//! - **Bearing off,** which is progress that nothing can take back.
//! - **The head,** which lets one checker leave per turn, so a checker still on it is a tempo that
//!   can't be made up.
//! - **Rows of points,** which are in the way of the opposing checkers behind them, and the
//!   opponent's, which are in the way of the bot's. A row of six is a wall.
//! - **Spread.** Checkers on many points have more ways to play a roll, and ones piled on a
//!   point are in each other's way.
//!
//! The weights were found by playing the bot against the medium bot and keeping the changes that
//! won more games (see `tune_hard` in the tests of the parent module). Terms for how many
//! of the dice a checker can't play because the points they would land on are held were tried
//! as well, for the opponent's checkers and for the bot's own, and the games found no use for
//! them, so they are not here.

use std::collections::HashSet;

use super::super::rules::{self, Points, Step, Turn, across};

/// How much each thing in a position is worth, in the order of the constants below.
pub(super) type Weights = [i32; 7];

/// What a checker borne off is worth.
const OFF: usize = 0;
/// What a checker still on the head costs.
const HEAD: usize = 1;
/// What a row of three, four and five or more points is worth when an opposing checker still
/// has to get past it.
const ROW_3: usize = 2;
const ROW_4: usize = 3;
const ROW_5: usize = 4;
/// What each point held outside the head is worth.
const SPREAD: usize = 5;
/// What a checker beyond the third on a point costs.
const PILE: usize = 6;

pub(super) const WEIGHTS: Weights = [20, 6, 3, 5, 15, 6, 3];

/// One way of playing on: the position it leads to, with the dice still to play, and the step
/// that began it.
#[derive(Clone, Copy)]
struct Line {
    turn: Turn,
    remaining: [u8; 4],
    left: usize,
    first: Option<Step>,
}

impl Line {
    /// What tells two lines that lead to the same place apart.
    fn key(&self) -> ([u8; 24], u8, u8, [u8; 4]) {
        // Only the dice that are left count: what is past them is what was played, in whatever
        // order the playing left it.
        let mut remaining = [0; 4];
        remaining[..self.left].copy_from_slice(&self.remaining[..self.left]);
        remaining[..self.left].sort_unstable();
        (
            self.turn.mine,
            self.turn.off,
            self.turn.head_left,
            remaining,
        )
    }
}

/// Every position the turn can end in, each with the first step of a way to get there. A step
/// is the first of many ways, and only one of them is kept: the one that comes first.
fn endings(turn: &Turn, remaining: &[u8]) -> Vec<(Step, Turn)> {
    let mut dice = [0; 4];
    dice[..remaining.len()].copy_from_slice(remaining);
    let mut layer = vec![Line {
        turn: *turn,
        remaining: dice,
        left: remaining.len(),
        first: None,
    }];
    let mut ends = Vec::new();
    // Each round plays one more die, so there are at most four. Two ways of playing the same
    // dice to the same position are one line, which keeps a double from being thousands.
    while !layer.is_empty() {
        let mut seen = HashSet::new();
        let mut next = Vec::new();
        for line in layer {
            let steps = rules::legal_steps(&line.turn, &line.remaining[..line.left]);
            if steps.is_empty() {
                if let Some(first) = line.first {
                    ends.push((first, line.turn));
                }
                continue;
            }
            for step in steps {
                let Ok(turn) = rules::play(&line.turn, step) else {
                    continue; // Not possible for a legal step.
                };
                let mut remaining = line.remaining;
                let at = remaining[..line.left]
                    .iter()
                    .position(|&die| die == step.die)
                    .expect("a legal step plays a die that is left");
                remaining[at] = remaining[line.left - 1];
                let played = Line {
                    turn,
                    remaining,
                    left: line.left - 1,
                    first: line.first.or(Some(step)),
                };
                if seen.insert(played.key()) {
                    next.push(played);
                }
            }
        }
        layer = next;
    }
    ends
}

/// How many points in a row of the bot's, in the opponent's order, an opposing checker still
/// has to get past, worth by the length of the row.
fn rows(mine: &Points, theirs: &Points, worth: [i32; 3]) -> i32 {
    let held = |their_point: usize| mine[usize::from(across(their_point as u8)) - 1] > 0;
    let mut total = 0;
    let mut start = 1;
    while start <= 24 {
        if !held(start) {
            start += 1;
            continue;
        }
        let mut end = start;
        while end < 24 && held(end + 1) {
            end += 1;
        }
        let length = end - start + 1;
        // Opposing checkers behind the row, which have to pass it.
        let behind = theirs[..start - 1].iter().any(|&n| n > 0);
        if length >= 3 && behind {
            total += worth[(length - 3).min(2)];
        }
        start = end + 1;
    }
    total
}

/// How good a position is for the player whose checkers are `mine` (with `off` borne off), as
/// they see it: higher is better. `theirs` is the opponent, in the opponent's own index.
fn evaluate(mine: &Points, off: u8, theirs: &Points, w: &Weights) -> i32 {
    let mut value = w[OFF] * i32::from(off) - w[HEAD] * i32::from(mine[0]);
    value += rows(mine, theirs, [w[ROW_3], w[ROW_4], w[ROW_5]]);
    value -= rows(theirs, mine, [w[ROW_3], w[ROW_4], w[ROW_5]]);
    let spread = mine[1..].iter().filter(|&&n| n > 0).count() as i32;
    value += w[SPREAD] * spread;
    let piled: i32 = mine.iter().map(|&n| i32::from(n.saturating_sub(3))).sum();
    value -= w[PILE] * piled;
    value
}

/// The step the hard bot plays, given the turn in progress and the dice still to play.
pub fn choose(turn: &Turn, remaining: &[u8]) -> Option<Step> {
    choose_with(turn, remaining, &WEIGHTS)
}

pub(super) fn choose_with(turn: &Turn, remaining: &[u8], weights: &Weights) -> Option<Step> {
    let mut best: Option<(i32, Step)> = None;
    for (first, end) in endings(turn, remaining) {
        let value = evaluate(&end.mine, end.off, &end.theirs, weights);
        if best.is_none_or(|(top, _)| value > top) {
            best = Some((value, first));
        }
    }
    best.map(|(_, step)| step)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use crate::bot::{Random, Seeded};

    /// A position of two players with fifteen checkers each, scattered over the points that
    /// each may stand on (never the same physical point), with the head rule fresh.
    fn scattered(rng: &mut Seeded) -> Turn {
        let mut mine = [0u8; 24];
        for _ in 0..15 {
            mine[rng.below(24).unwrap()] += 1;
        }
        // Their point `at + 1` is the point that is `across` it in the bot's index. The bot holds
        // at most fifteen points of the twenty-four, so there are always free ones.
        let mut theirs = [0u8; 24];
        let mut placed = 0;
        while placed < 15 {
            let at = rng.below(24).unwrap();
            if mine[usize::from(across(at as u8 + 1)) - 1] == 0 {
                theirs[at] += 1;
                placed += 1;
            }
        }
        Turn {
            mine,
            off: 0,
            theirs,
            head_left: 1,
        }
    }

    /// Every position that a turn can end in, found by walking all the lines with no
    /// shortcuts: the same two ways of playing the same dice are walked twice.
    fn brute_force(turn: &Turn, remaining: &[u8], ends: &mut BTreeSet<([u8; 24], u8)>) {
        let steps = rules::legal_steps(turn, remaining);
        if steps.is_empty() {
            ends.insert((turn.mine, turn.off));
            return;
        }
        for step in steps {
            let next = rules::play(turn, step).unwrap();
            let mut rest = remaining.to_vec();
            rest.remove(rest.iter().position(|&die| die == step.die).unwrap());
            brute_force(&next, &rest, ends);
        }
    }

    #[test]
    fn the_endings_are_the_positions_that_every_complete_turn_ends_in() {
        let mut rng = Seeded::new(42);
        for _ in 0..150 {
            let turn = scattered(&mut rng);
            let (a, b) = (rng.die(), rng.die());
            let dice: Vec<u8> = if a == b { vec![a; 4] } else { vec![a, b] };

            let found = endings(&turn, &dice);

            let mut expected = BTreeSet::new();
            brute_force(&turn, &dice, &mut expected);
            let got: BTreeSet<_> = found.iter().map(|(_, end)| (end.mine, end.off)).collect();
            assert_eq!(got, expected, "{dice:?}");
            // One entry for each position, and the step it starts with is one the rules allow.
            assert_eq!(found.len(), got.len(), "{dice:?}");
            let allowed = rules::legal_steps(&turn, &dice);
            assert!(found.iter().all(|(first, _)| allowed.contains(first)));
        }
    }

    #[test]
    fn a_turn_that_can_play_nothing_has_no_ending_and_no_step() {
        // Every point that a die from the head lands on is held.
        let mut theirs = [0u8; 24];
        for point in 1..=24usize {
            theirs[usize::from(across(point as u8)) - 1] = 1;
        }
        theirs[13] += 2; // Fifteen in all.
        let mut mine = [0u8; 24];
        mine[0] = 15;
        let turn = Turn {
            mine,
            off: 0,
            theirs: [0; 24],
            head_left: 1,
        };
        let blocked = Turn { theirs, ..turn };

        assert!(endings(&blocked, &[3, 5]).is_empty());
        assert_eq!(choose(&blocked, &[3, 5]), None);
    }

    #[test]
    fn a_double_has_a_handful_of_endings_not_thousands() {
        let mut rng = Seeded::new(9);
        let mut most = 0;
        for _ in 0..50 {
            let turn = scattered(&mut rng);
            let die = rng.die();

            most = most.max(endings(&turn, &[die; 4]).len());
        }

        // Fifteen checkers on up to fifteen points, four steps: far fewer than the lines.
        assert!(most < 2_000, "{most} endings");
    }

    #[test]
    fn it_plays_a_turn_to_the_best_ending_by_its_own_score() {
        let mut rng = Seeded::new(7);
        for _ in 0..60 {
            let start = scattered(&mut rng);
            let (a, b) = (rng.die(), rng.die());
            let mut remaining: Vec<u8> = if a == b { vec![a; 4] } else { vec![a, b] };
            let best = endings(&start, &remaining)
                .iter()
                .map(|(_, end)| evaluate(&end.mine, end.off, &end.theirs, &WEIGHTS))
                .max();

            // Play it step by step, as the room does: each step asks again.
            let mut turn = start;
            while let Some(step) = choose(&turn, &remaining) {
                turn = rules::play(&turn, step).unwrap();
                remaining.remove(remaining.iter().position(|&die| die == step.die).unwrap());
            }

            let played = evaluate(&turn.mine, turn.off, &turn.theirs, &WEIGHTS);
            assert_eq!(Some(played), best, "{a} {b}");
        }
    }
}
