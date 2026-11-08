//! The computer opponent.
//!
//! The bot is a user like any other, with a row in `users` (made by a migration) and a seat
//! in the games it plays, so that the rest of the system needs no special case for it: its
//! name shows up in the players' names, and it is listed among a game's players. What makes
//! it a bot is that it has no access token, so nobody can act as it, and that a room plays
//! for it (see `room`).
//!
//! What a bot plays is up to each game: [`crate::game::Game::bot_action`].

use uuid::Uuid;

/// The bot's user id. The migration that creates the bot gives it the same one.
pub const BOT_USER: Uuid = Uuid::from_u128(0xb07a);

#[cfg(test)]
mod tests {
    use sqlx::PgPool;

    use super::*;

    #[sqlx::test]
    async fn the_bot_is_a_user_that_nobody_can_sign_in_as(pool: PgPool) {
        let row: (Option<String>, Option<String>) =
            sqlx::query_as("SELECT access_token, name FROM users WHERE id = $1")
                .bind(BOT_USER)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(row, (None, Some("Bot".to_owned())));
    }
}
