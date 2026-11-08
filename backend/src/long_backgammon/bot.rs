//! The computer opponent of long backgammon.
//!
//! It plays one action at a time and keeps nothing between them: rolling when it is time to
//! roll, and otherwise the step it likes best of the ones the rules allow (`State::legal`,
//! with the must-play rules applied). So it can't break a rule, and it picks up where it left
//! off in a game that was stored half way through its turn.
//!
//! "Likes best" is a score for the position a step leads to ([`value`]), and the highest
//! wins; the lowest checker and then the lowest die win a tie, which moves the rearmost
//! checker first. It looks one step ahead and no further, so it is a careful player, not a
//! strong one. The things it cares about are the ones that decide a game of long backgammon:
//!
//! - **The head.** Only one checker may leave it each turn, so a checker still there is a
//!   tempo that can't be made up later. It takes one off whenever it can.
//! - **Blocking.** There is no hitting, so the way to win a fight is to hold points that the
//!   opponent's checkers want to land on. The more of the six points in front of an opposing
//!   checker are held by the bot, the fewer dice that checker can play.
//! - **Bearing off,** which is progress that nothing can take back.
//!
//! It doesn't count pips: every way of playing a roll moves the same number of them, so a
//! score for them would only make it prefer the bigger die over the better position.

use super::{
    Action, Phase, State,
    rules::{self, Points, across},
};

/// What a checker borne off is worth. More than anything the board can offer, so that a
/// step that bears one off beats a step that merely improves the position.
const OFF: i32 = 20;

/// What a checker still on the head costs.
const HEAD: i32 = 6;

/// What each point held in front of an opposing checker is worth. A "point in front of" is
/// one of the six that follow a checker on the opponent's path, where a die can take it.
const BLOCK: i32 = 3;

/// The action the bot plays for `seat`, or `None` if it isn't `seat`'s turn or the game is over.
pub fn action(state: &State, seat: usize) -> Option<Action> {
    let position = &state.position;
    if position.turn != seat {
        return None;
    }
    match &position.phase {
        Phase::Roll => Some(Action::Roll),
        Phase::Move { dice, played, .. } => {
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
            best.map(|(_, step)| Action::Move {
                from: step.from,
                die: step.die,
            })
        }
        Phase::Over { .. } => None,
    }
}

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

    fn step(state: &State) -> (u8, u8) {
        match action(state, 0) {
            Some(Action::Move { from, die }) => (from, die),
            other => panic!("expected a step, got {other:?}"),
        }
    }

    #[test]
    fn it_rolls_when_it_is_time_to_roll() {
        let state = State::reached(Position::new(0));

        assert_eq!(action(&state, 0), Some(Action::Roll));
    }

    #[test]
    fn it_does_nothing_on_the_opponents_turn() {
        let state = State::reached(Position::new(0));

        assert_eq!(action(&state, 1), None);
    }

    #[test]
    fn it_does_nothing_when_the_game_is_over() {
        let mut position = Position::new(0);
        position.phase = Phase::Over {
            winner: Some(0),
            points: 1,
        };

        assert_eq!(action(&State::reached(position), 0), None);
    }

    #[test]
    fn it_takes_a_checker_off_the_head_when_it_can() {
        // Fifteen on the head and nothing else: the 3 and the 5 can only be played from the
        // head, and the rules let one checker leave it, so that one is taken.
        let state = rolled(&[(1, 15)], &[(1, 15)], [0, 0], [5, 3]);

        let (from, _) = step(&state);

        assert_eq!(from, 1);
    }

    #[test]
    fn it_does_not_try_a_second_checker_off_the_head_once_the_head_is_used() {
        // A checker has left the head this turn, so the head is used up and what is left to play
        // can't come from it.
        let state = rolled(&[(1, 14), (8, 1)], &[(1, 15)], [0, 0], [5, 4]);
        let state = state
            .act(0, Action::Move { from: 1, die: 5 }, || None)
            .expect("the head step is legal");

        let (from, die) = step(&state);

        assert_ne!(from, 1, "the head is used up for this turn");
        assert!(state.legal.iter().any(|s| s.from == from && s.die == die));
    }

    #[test]
    fn it_bears_off_rather_than_moving_a_checker_inside_the_home() {
        // All home. A 1 can bear off the checker on 24 or move the one on 20 to 21.
        let state = rolled(&[(20, 1), (24, 1)], &[(1, 15)], [13, 0], [1, 1]);

        let (from, die) = step(&state);

        assert_eq!((from, die), (24, 1));
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
    fn what_it_plays_is_always_a_legal_step() {
        // A hundred rolls of dice from a position with a bit of everything.
        let mut dice = Dice(7);
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

            let (from, die) = step(&state);

            assert!(
                state.legal.iter().any(|s| s.from == from && s.die == die),
                "{roll:?}"
            );
        }
    }

    // --- Playing whole games ---

    /// Dice and choices that anyone can repeat: xorshift64*.
    struct Dice(u64);

    impl Dice {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }

        fn die(&mut self) -> u8 {
            (self.next() >> 33) as u8 % 6 + 1
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() >> 33) as usize % n
        }
    }

    /// Plays a whole game in which `bot` plays for one seat and a player who picks a legal step
    /// at random plays for the other. Returns the winning seat, or `None` for a draw.
    fn play_out(bot: usize, seed: u64) -> Option<usize> {
        let mut rng = Dice(seed | 1);
        let white = rng.below(2);
        let mut state = State::reached(Position::new(white));
        for _ in 0..5000 {
            if let Phase::Over { winner, .. } = state.position.phase {
                return winner;
            }
            let seat = state.position.turn;
            let chosen = if seat == bot {
                action(&state, seat).expect("the bot has an action on its turn")
            } else {
                match state.position.phase {
                    Phase::Roll => Action::Roll,
                    _ => {
                        let step = state.legal[rng.below(state.legal.len())];
                        Action::Move {
                            from: step.from,
                            die: step.die,
                        }
                    }
                }
            };
            let roll = [rng.die(), rng.die()];
            state = state
                .act(seat, chosen, || Some(roll))
                .unwrap_or_else(|err| panic!("{chosen:?} was refused: {}", err.reason()));
        }
        panic!("the game did not end");
    }

    #[test]
    fn it_finishes_games_without_ever_breaking_a_rule_and_beats_a_player_who_picks_at_random() {
        let games = 100;
        let wins = (0..games)
            .filter(|&n| play_out(n % 2, 1000 + n as u64) == Some(n % 2))
            .count();

        // The bot wins about nine of ten of these. Chance would be one in two. The games are
        // repeatable, so this never wavers; it is here to notice a change that makes the bot
        // play worse than a coin, not to rate it.
        assert!(wins >= 75, "the bot won only {wins} of {games}");
    }
}
