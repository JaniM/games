-- The computer opponent: a user that sits in games like any other, so that `game_players`
-- needs nothing special for it. It has no access token, so nobody can sign in as it
-- (`WHERE access_token = $1` never matches a null), and nothing can rename it.
--
-- The id is fixed and is also `BOT_USER` in `src/bot.rs`; keep the two the same.
ALTER TABLE users ALTER COLUMN access_token DROP NOT NULL;

INSERT INTO users (id, access_token, name)
VALUES ('00000000-0000-0000-0000-00000000b07a', NULL, 'Bot');
