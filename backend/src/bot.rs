//! The computer opponent.
//!
//! A bot is a user like any other, with a row in `users` (made by a migration) and a seat in
//! the games it plays, so that the rest of the system needs no special case for it: its name
//! shows up in the players' names, and it is listed among a game's players. What makes it a
//! bot is `users.is_bot`, that it has no access token, so nobody can act as it, and that a room
//! plays for it (see `room`).
//!
//! There are three bots, one for each [`Level`], so a game's level is which of them sits in it:
//! it is stored with the players, and a rematch, which has the same players, has the same level.
//!
//! - **Easy** plays any move the rules allow, picked at random.
//! - **Medium** looks at the move it is about to make and no further, and likes the ones that
//!   win something or avoid losing something.
//! - **Hard** looks ahead, and plays what it expects to come out best.
//!
//! What each of them plays is up to each game: [`crate::game::Game::bot_action`]. Medium has to
//! win most of its games against Easy, and Hard most of its games against Medium: each game's
//! bot has a test that plays them against each other to see that it does.

use serde::Deserialize;
use uuid::Uuid;

/// How well the bot plays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Easy,
    Medium,
    Hard,
}

impl Level {
    pub const ALL: [Level; 3] = [Level::Easy, Level::Medium, Level::Hard];

    /// What a game against the bot is when the player doesn't say. It is the bot that there was
    /// before there were levels, so games made by older clients are the games they always were.
    pub const DEFAULT: Level = Level::Medium;

    /// The bot's user id. The migration that creates the bot gives it the same one.
    pub const fn user(self) -> Uuid {
        match self {
            Level::Easy => Uuid::from_u128(0xb07b),
            Level::Medium => Uuid::from_u128(0xb07a),
            Level::Hard => Uuid::from_u128(0xb07c),
        }
    }

    /// The level of the bot that is `user`, or `None` if `user` is not a bot.
    pub fn of(user: Uuid) -> Option<Level> {
        Self::ALL.into_iter().find(|level| level.user() == user)
    }
}

/// Where a bot's random choices come from. Only the choices that are not about which move is
/// best (a move at random, or among moves that are equally good) need it, and a bot that is
/// given one can be played again move for move.
pub trait Random {
    /// A number from 0 up to, not including, `n`, every one as likely as the others. `None` for
    /// `n == 0`, and if there is no random source to ask.
    fn below(&mut self, n: usize) -> Option<usize>;
}

/// The system's random source, which is what a bot in a game uses.
pub struct System;

impl Random for System {
    /// A byte has 256 values, which `n` need not divide, so the last few are skipped.
    fn below(&mut self, n: usize) -> Option<usize> {
        if n == 0 || n > 256 {
            return None;
        }
        let limit = 256 - 256 % n;
        loop {
            let mut byte = [0u8; 1];
            getrandom::fill(&mut byte).ok()?;
            if usize::from(byte[0]) < limit {
                return Some(usize::from(byte[0]) % n);
            }
        }
    }
}

/// Choices that anyone can repeat: xorshift64*.
#[cfg(test)]
pub struct Seeded(u64);

#[cfg(test)]
impl Seeded {
    pub fn new(seed: u64) -> Self {
        // The generator never leaves zero.
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// A die, for a game that plays with them.
    pub fn die(&mut self) -> u8 {
        (self.next() >> 33) as u8 % 6 + 1
    }
}

#[cfg(test)]
impl Random for Seeded {
    fn below(&mut self, n: usize) -> Option<usize> {
        (n > 0).then(|| (self.next() >> 33) as usize % n)
    }
}

#[cfg(test)]
mod tests {
    use sqlx::PgPool;

    use super::*;

    #[test]
    fn every_level_has_a_user_of_its_own_and_they_can_be_told_apart() {
        for level in Level::ALL {
            assert_eq!(Level::of(level.user()), Some(level));
        }
        assert_eq!(Level::of(Uuid::nil()), None);
        assert_eq!(Level::of(Uuid::from_u128(1)), None);
    }

    #[test]
    fn the_default_is_the_bot_that_there_was_before_the_levels() {
        assert_eq!(Level::DEFAULT.user(), Uuid::from_u128(0xb07a));
    }

    #[test]
    fn a_level_is_read_from_its_lowercase_name() {
        let read = |name: &str| serde_json::from_str::<Level>(&format!("\"{name}\""));

        assert_eq!(read("easy").unwrap(), Level::Easy);
        assert_eq!(read("medium").unwrap(), Level::Medium);
        assert_eq!(read("hard").unwrap(), Level::Hard);
        assert!(read("Hard").is_err());
        assert!(read("impossible").is_err());
    }

    #[test]
    fn the_system_picks_every_number_below_n_and_nothing_else() {
        let mut seen = [false; 5];
        for _ in 0..500 {
            seen[System.below(5).unwrap()] = true;
        }
        assert_eq!(seen, [true; 5]);
        assert_eq!(System.below(0), None);
        assert_eq!(System.below(1), Some(0));
    }

    #[test]
    fn a_seeded_source_repeats_itself() {
        let picks = |seed| {
            let mut rng = Seeded::new(seed);
            (0..20)
                .map(|_| rng.below(1000).unwrap())
                .collect::<Vec<_>>()
        };

        assert_eq!(picks(7), picks(7));
        assert_ne!(picks(7), picks(8));
    }

    /// The bots as the migrations leave them: the same ids, flagged as bots, with a name each
    /// that no account can have, and nobody else flagged.
    #[sqlx::test]
    async fn the_bots_are_users_that_nobody_can_sign_in_as(pool: PgPool) {
        type Row = (Uuid, Option<String>, Option<String>, Option<String>);
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, access_token, username, name FROM users WHERE is_bot ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        let expected = |level: Level, name: &str| (level.user(), None, None, Some(name.to_owned()));
        assert_eq!(
            rows,
            vec![
                expected(Level::Easy, "Easy bot"),
                expected(Level::Hard, "Hard bot"),
                expected(Level::Medium, "Medium bot"),
            ]
        );
    }

    #[sqlx::test]
    async fn the_bot_users_are_found_by_a_partial_index_on_the_flag(pool: PgPool) {
        let indexed: Option<String> = sqlx::query_scalar(
            "SELECT indexdef FROM pg_indexes WHERE tablename = 'users' AND indexname = 'users_is_bot'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap();

        assert!(indexed.is_some_and(|definition| definition.contains("WHERE is_bot")));
    }
}
