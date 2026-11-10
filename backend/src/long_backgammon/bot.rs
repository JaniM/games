//! The computer opponent of long backgammon, at each of its three levels (see [`crate::bot`]).
//!
//! It plays one action at a time and keeps nothing between them: rolling when it is time to
//! roll, and otherwise a step of the ones the rules allow (`State::legal`, with the must-play
//! rules applied). So it can't break a rule, and it picks up where it left off in a game that was
//! stored half way through its turn.
//!
//! - **Easy** plays any step the rules allow, at random.
//! - **Medium** plays the step it likes best, which is a score for the position the step leads to
//!   ([`value`]): the lowest checker and then the lowest die win a tie, which moves the rearmost
//!   checker first. It looks one step ahead and no further, so it is a careful player, not a
//!   strong one. The things it cares about are the ones that decide a game of long backgammon:
//!
//!   - **The head.** Only one checker may leave it each turn, so a checker still there is a
//!     tempo that can't be made up later. It takes one off whenever it can.
//!   - **Blocking.** There is no hitting, so the way to win a fight is to hold points that the
//!     opponent's checkers want to land on. The more of the six points in front of an opposing
//!     checker are held by the bot, the fewer dice that checker can play.
//!   - **Bearing off,** which is progress that nothing can take back.
//!
//!   It doesn't count pips: every way of playing a roll moves the same number of them, so a
//!   score for them would only make it prefer the bigger die over the better position.
//!
//! - **Hard** plans the whole turn ([`hard`]).

mod hard;

use super::{
    Action, Phase, State,
    rules::{self, Points, across},
};
use crate::bot::{Level, Random};

/// Whether the bot has something to do for `seat`: it is `seat`'s turn and the game is on.
pub fn to_move(state: &State, seat: usize) -> bool {
    state.position.turn == seat && !matches!(state.position.phase, Phase::Over { .. })
}

/// The action the bot plays for `seat` at `level`, or `None` if it isn't `seat`'s turn or the
/// game is over, or `rng` has nothing to choose with.
pub fn action(state: &State, seat: usize, level: Level, rng: &mut dyn Random) -> Option<Action> {
    if !to_move(state, seat) {
        return None;
    }
    let position = &state.position;
    match &position.phase {
        Phase::Roll => Some(Action::Roll),
        Phase::Move {
            dice,
            remaining,
            played,
        } => {
            let step = match level {
                Level::Easy => state.legal.get(rng.below(state.legal.len())?).copied(),
                Level::Medium => greedy(state),
                Level::Hard => hard::choose(&position.turn_view(*dice, played), remaining),
            }?;
            Some(Action::Move {
                from: step.from,
                die: step.die,
            })
        }
        Phase::Over { .. } => None,
    }
}

/// The step the medium bot likes best: the highest [`value`] for the position after it.
fn greedy(state: &State) -> Option<rules::Step> {
    let position = &state.position;
    let Phase::Move { dice, played, .. } = &position.phase else {
        return None;
    };
    let turn = position.turn_view(*dice, played);
    let mut best: Option<(i32, rules::Step)> = None;
    for &step in &state.legal {
        let Ok(next) = rules::play(&turn, step) else {
            continue; // Not possible for a legal step, and then there is nothing to score.
        };
        let value = value(&next.mine, next.off, &next.theirs);
        // Strictly better, so the first of equals stays.
        if best.is_none_or(|(top, _)| value > top) {
            best = Some((value, step));
        }
    }
    best.map(|(_, step)| step)
}

/// What a checker borne off is worth. More than anything the board can offer, so that a
/// step that bears one off beats a step that merely improves the position.
const OFF: i32 = 20;

/// What a checker still on the head costs.
const HEAD: i32 = 6;

/// What each point held in front of an opposing checker is worth. A "point in front of" is
/// one of the six that follow a checker on the opponent's path, where a die can take it.
const BLOCK: i32 = 3;

/// How good a position is for the player whose checkers are `mine` (with `off` borne off), as
/// they see it: higher is better. `theirs` is the opponent, in the opponent's own index.
fn value(mine: &Points, off: u8, theirs: &Points) -> i32 {
    let held = |points: &Points, index: usize| points[index - 1] > 0;
    let mut value = OFF * i32::from(off) - HEAD * i32::from(mine[0]);

    // For every opposing checker's point, the next six on its path that the bot holds. The
    // opponent's point `q` is the bot's `across(q)`.
    for from in 1..=24usize {
        if !held(theirs, from) {
            continue;
        }
        for to in from + 1..=(from + 6).min(24) {
            if held(mine, usize::from(across(to as u8))) {
                value += BLOCK;
            }
        }
    }

    value
}

#[cfg(test)]
mod tests {
    use super::super::{Position, rules::tests::points};
    use super::*;
    use crate::bot::Seeded;

    /// A position with the bot (seat 0) to move, having rolled `dice`. Both players have had a
    /// turn, so the first-turn exception for doubles is out of the way.
    fn rolled(mine: &[(u8, u8)], theirs: &[(u8, u8)], off: [u8; 2], dice: [u8; 2]) -> State {
        let position = Position {
            points: [points(mine), points(theirs)],
            off,
            turns: [1, 1],
            ..Position::new(0)
        };
        let state = State::reached(position);
        state
            .act(0, Action::Roll, || Some(dice))
            .expect("the roll is accepted")
    }

    /// The step a bot of `level` plays for seat 0.
    fn step_at(state: &State, level: Level) -> (u8, u8) {
        match action(state, 0, level, &mut Seeded::new(1)) {
            Some(Action::Move { from, die }) => (from, die),
            other => panic!("expected a step, got {other:?}"),
        }
    }

    fn step(state: &State) -> (u8, u8) {
        step_at(state, Level::Medium)
    }

    #[test]
    fn a_bot_of_every_level_rolls_when_it_is_time_to_roll() {
        let state = State::reached(Position::new(0));

        for level in Level::ALL {
            assert_eq!(
                action(&state, 0, level, &mut Seeded::new(1)),
                Some(Action::Roll)
            );
        }
    }

    #[test]
    fn a_bot_of_every_level_does_nothing_on_the_opponents_turn() {
        let state = State::reached(Position::new(0));

        for level in Level::ALL {
            assert_eq!(action(&state, 1, level, &mut Seeded::new(1)), None);
        }
        assert!(to_move(&state, 0));
        assert!(!to_move(&state, 1));
    }

    #[test]
    fn a_bot_of_every_level_does_nothing_when_the_game_is_over() {
        let mut position = Position::new(0);
        position.phase = Phase::Over {
            winner: Some(0),
            points: 1,
            forfeited: false,
        };
        let state = State::reached(position);

        for level in Level::ALL {
            assert_eq!(action(&state, 0, level, &mut Seeded::new(1)), None);
        }
        assert!(!to_move(&state, 0));
    }

    #[test]
    fn it_takes_a_checker_off_the_head_when_it_can() {
        // Fifteen on the head and nothing else: the 3 and the 5 can only be played from the
        // head, and the rules let one checker leave it, so that one is taken.
        let state = rolled(&[(1, 15)], &[(1, 15)], [0, 0], [5, 3]);

        for level in Level::ALL {
            let (from, _) = step_at(&state, level);

            assert_eq!(from, 1, "{level:?}");
        }
    }

    #[test]
    fn it_does_not_try_a_second_checker_off_the_head_once_the_head_is_used() {
        // A checker has left the head this turn, so the head is used up and what is left to play
        // can't come from it.
        let state = rolled(&[(1, 14), (8, 1)], &[(1, 15)], [0, 0], [5, 4]);
        let state = state
            .act(0, Action::Move { from: 1, die: 5 }, || None)
            .expect("the head step is legal");

        for level in Level::ALL {
            let (from, die) = step_at(&state, level);

            assert_ne!(from, 1, "the head is used up for this turn ({level:?})");
            assert!(state.legal.iter().any(|s| s.from == from && s.die == die));
        }
    }

    /// The state after the bot of `level` has played the rest of its turn as seat 0.
    fn played_out(mut state: State, level: Level) -> State {
        let mut rng = Seeded::new(1);
        while state.position.turn == 0 && matches!(state.position.phase, Phase::Move { .. }) {
            let chosen = action(&state, 0, level, &mut rng).expect("the bot has a step");
            state = state.act(0, chosen, || None).expect("the step is legal");
        }
        state
    }

    #[test]
    fn it_bears_off_rather_than_moving_a_checker_inside_the_home() {
        // All home. A 1 can bear off the checker on 24 or move the one on 20 to 21. The medium
        // bot, which plays a step at a time, bears off first.
        let state = rolled(&[(20, 1), (24, 1)], &[(1, 15)], [13, 0], [1, 1]);

        assert_eq!(step(&state), (24, 1));
    }

    #[test]
    fn it_bears_off_a_checker_in_a_turn_that_can() {
        // The same, played to the end: a double 1 has four steps, and bearing off the checker on
        // 24 is one of them whichever the bot plays first. The hard bot plans the turn, so what
        // it plays first may be any of the steps that lead to the same place.
        let state = rolled(&[(20, 1), (24, 1)], &[(1, 15)], [13, 0], [1, 1]);

        for level in [Level::Medium, Level::Hard] {
            let after = played_out(state.clone(), level);

            assert_eq!(after.position.off[0], 14, "{level:?}");
        }
    }

    #[test]
    fn it_puts_a_checker_in_the_way_of_the_opponents_head() {
        // The opponent has everything on its head, and the six points it leaves to (2 to 7 in
        // its numbering) are the bot's 14 to 19. A checker on 12 reaches 14 with a 2 or 15 with
        // a 3, and either holds one of them. The checkers on 10 can go no further than 12 with
        // these dice, which blocks nothing.
        let state = rolled(&[(10, 14), (12, 1)], &[(1, 15)], [0, 0], [3, 2]);

        let (from, die) = step(&state);

        assert_eq!(from, 12);
        assert!(matches!(from + die, 14 | 15));
    }

    #[test]
    fn the_easy_bot_plays_any_step_the_rules_allow() {
        // Both dice can be played from the head or from 8, so the steps are many.
        let state = rolled(&[(1, 14), (8, 1)], &[(1, 15)], [0, 0], [5, 4]);
        let mut rng = Seeded::new(5);

        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            match action(&state, 0, Level::Easy, &mut rng) {
                Some(Action::Move { from, die }) => {
                    assert!(state.legal.iter().any(|s| s.from == from && s.die == die));
                    seen.insert((from, die));
                }
                other => panic!("{other:?}"),
            }
        }

        assert_eq!(seen.len(), state.legal.len(), "{seen:?}");
        assert!(seen.len() > 2);
    }

    #[test]
    fn what_it_plays_is_always_a_legal_step() {
        // A hundred rolls of dice from a position with a bit of everything.
        let mut dice = Seeded::new(7);
        for _ in 0..100 {
            let roll = [dice.die(), dice.die()];
            let state = rolled(
                &[(1, 9), (5, 2), (9, 1), (14, 1), (19, 1), (22, 1)],
                &[(1, 11), (6, 2), (16, 1), (20, 1)],
                [0, 0],
                roll,
            );
            if state.position.phase == Phase::Roll {
                continue; // Nothing could be played, and the turn went by.
            }

            for level in Level::ALL {
                let (from, die) = step_at(&state, level);

                assert!(
                    state.legal.iter().any(|s| s.from == from && s.die == die),
                    "{level:?} {roll:?}"
                );
            }
        }
    }

    // --- Playing whole games ---

    /// How a seat decides what to do: the action for the seat in a state, given the dice and
    /// choices of the game.
    type Policy<'a> = &'a (dyn Fn(&State, usize, &mut Seeded) -> Option<Action> + Sync);

    /// Plays a whole game, `policies[seat]` deciding for each seat, and returns the winning
    /// seat, or `None` for a draw.
    fn play_with(policies: [Policy; 2], seed: u64) -> Option<usize> {
        let mut rng = Seeded::new(seed);
        let white = rng.below(2).unwrap();
        let mut state = State::reached(Position::new(white));
        for _ in 0..5000 {
            if let Phase::Over { winner, .. } = state.position.phase {
                return winner;
            }
            let seat = state.position.turn;
            let chosen =
                policies[seat](&state, seat, &mut rng).expect("the bot has an action on its turn");
            let roll = [rng.die(), rng.die()];
            state = state
                .act(seat, chosen, || Some(roll))
                .unwrap_or_else(|err| panic!("{chosen:?} was refused: {}", err.reason()));
        }
        panic!("the game did not end");
    }

    /// The policy of the bot of a level.
    fn level_policy(level: Level) -> impl Fn(&State, usize, &mut Seeded) -> Option<Action> + Sync {
        move |state, seat, rng| action(state, seat, level, rng)
    }

    /// Plays a whole game in which a bot of level `levels[seat]` plays each seat, and returns
    /// the winning seat, or `None` for a draw.
    fn play_out(levels: [Level; 2], seed: u64) -> Option<usize> {
        let (first, second) = (level_policy(levels[0]), level_policy(levels[1]));
        play_with([&first, &second], seed)
    }

    /// How `a` does against `b` in `games` games, as [a's wins, b's wins, draws]. They take
    /// each seat in turn, and the dice are the same whoever plays what, as far as the games go.
    fn tournament(a: Level, b: Level, games: usize, seed: u64) -> [usize; 3] {
        let mut score = [0; 3];
        for game in 0..games {
            let a_seat = game % 2;
            let mut levels = [b; 2];
            levels[a_seat] = a;
            match play_out(levels, seed + game as u64) {
                Some(seat) if seat == a_seat => score[0] += 1,
                Some(_) => score[1] += 1,
                None => score[2] += 1,
            }
        }
        score
    }

    /// A hard bot with the given weights, for measuring them.
    fn hard_with(
        weights: hard::Weights,
    ) -> impl Fn(&State, usize, &mut Seeded) -> Option<Action> + Sync {
        move |state, seat, rng| match &state.position.phase {
            Phase::Move {
                dice,
                remaining,
                played,
            } if state.position.turn == seat => {
                let step = hard::choose_with(
                    &state.position.turn_view(*dice, played),
                    remaining,
                    &weights,
                )?;
                Some(Action::Move {
                    from: step.from,
                    die: step.die,
                })
            }
            _ => action(state, seat, Level::Hard, rng),
        }
    }

    /// How a policy does against the medium bot over `games` games on as many threads as there
    /// are, in points per game: a win is 1 and a draw a half. They take each seat in turn.
    fn against_medium(policy: Policy, games: usize, seed: u64) -> f64 {
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
        let medium = level_policy(Level::Medium);
        let points: f64 = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..threads)
                .map(|worker| {
                    let medium = &medium;
                    scope.spawn(move || {
                        let mut points = 0.0;
                        for game in (worker..games).step_by(threads) {
                            let seat = game % 2;
                            let mut policies: [Policy; 2] = [medium, medium];
                            policies[seat] = policy;
                            match play_with(policies, seed + game as u64) {
                                Some(winner) if winner == seat => points += 1.0,
                                None => points += 0.5,
                                _ => {}
                            }
                        }
                        points
                    })
                })
                .collect();
            workers.into_iter().map(|w| w.join().unwrap()).sum()
        });
        points / games as f64
    }

    /// Hill-climbs the hard bot's weights against the medium bot, and prints what it finds. A
    /// measurement, run by hand in release mode:
    /// `cargo test --release tune_hard -- --ignored --nocapture`
    /// `GAMES` is how many games it plays to judge a set of weights, and `FROM` (comma
    /// separated) the weights to start from. The games it learns from are not the games it is
    /// then measured on.
    #[test]
    #[ignore = "a measurement, not a check"]
    fn tune_hard() {
        let games: usize = std::env::var("GAMES")
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(1500);
        let mut weights = hard::WEIGHTS;
        if let Ok(from) = std::env::var("FROM") {
            for (slot, value) in weights.iter_mut().zip(from.split(',')) {
                *slot = value.trim().parse().unwrap();
            }
        }
        let judge =
            |weights: hard::Weights, seed: u64| against_medium(&hard_with(weights), games, seed);
        let mut best = judge(weights, 1_000_000);
        println!("start {weights:?}: {:.1}%", best * 100.0);
        let steps = [4, 2, 2, 3, 4, 1, 1];
        for round in 0..4 {
            let mut improved = false;
            for slot in 0..weights.len() {
                for sign in [1, -1] {
                    let mut trial = weights;
                    trial[slot] += sign * steps[slot] * (3 - round.min(2));
                    // A fresh set of games each time, so that a lucky set can't be climbed.
                    let seed = 1_000_000 + 7919 * (round * 100 + slot as i32 * 2) as u64;
                    let (a, b) = (judge(trial, seed), judge(weights, seed));
                    if a > b + 0.01 {
                        weights = trial;
                        best = a;
                        improved = true;
                        println!(
                            "round {round} weight {slot} -> {}: {:.1}% (was {:.1}%)",
                            weights[slot],
                            a * 100.0,
                            b * 100.0
                        );
                        break;
                    }
                }
            }
            println!("after round {round}: {weights:?} {:.1}%", best * 100.0);
            if !improved && round >= 2 {
                break;
            }
        }
        println!(
            "final {weights:?} on fresh games: {:.1}%",
            judge(weights, 9_000_000) * 100.0
        );
    }

    #[test]
    fn bots_of_every_pair_of_levels_finish_games_without_ever_breaking_a_rule() {
        for a in Level::ALL {
            for b in Level::ALL {
                for game in 0..4 {
                    play_out([a, b], 500 + game);
                }
            }
        }
    }

    #[test]
    fn the_medium_bot_beats_the_easy_bot_nine_games_in_ten() {
        let [medium, easy, drawn] = tournament(Level::Medium, Level::Easy, 100, 1000);

        // The games are repeatable, so this never wavers: it is here to notice a change that
        // makes the bot play worse than a coin, not to rate it.
        assert!(
            medium >= 85,
            "medium won {medium}, easy {easy}, drawn {drawn}"
        );
    }

    #[test]
    fn the_hard_bot_beats_the_medium_bot_six_games_in_ten() {
        let [hard, medium, drawn] = tournament(Level::Hard, Level::Medium, 150, 3000);

        // The games are repeatable, so this never wavers. It is well below what the hard bot
        // wins, so that it notices a change that makes it play worse, not one that is noise.
        assert!(
            hard >= 85,
            "hard won {hard}, medium {medium}, drawn {drawn}"
        );
    }

    #[test]
    fn the_hard_bot_beats_the_easy_bot_nine_games_in_ten() {
        let [hard, easy, drawn] = tournament(Level::Hard, Level::Easy, 100, 4000);

        assert!(hard >= 85, "hard won {hard}, easy {easy}, drawn {drawn}");
    }

    /// Prints how every level does against every other. Run it when changing a bot, in release
    /// mode because the hard bot is slow without it:
    /// `cargo test --release tournament_report -- --ignored --nocapture`
    #[test]
    #[ignore = "a measurement, not a check"]
    fn tournament_report() {
        let games: usize = std::env::var("GAMES")
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(1000);
        for (a, b) in [
            (Level::Medium, Level::Easy),
            (Level::Hard, Level::Medium),
            (Level::Hard, Level::Easy),
        ] {
            let [won, lost, drawn] = tournament(a, b, games, 77_000);
            println!(
                "{a:?} against {b:?}: won {won}, lost {lost}, drawn {drawn} of {games} ({:.1}% won)",
                100.0 * won as f64 / games as f64
            );
        }
    }
}
