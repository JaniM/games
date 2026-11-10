-- The computer opponent comes in three levels, each a user of its own (see `src/bot.rs`), so
-- that a game keeps its level the way it keeps its players: through a restart, and into a
-- rematch.
--
-- Queries ask the column whether a user is a bot, not whether they are one particular user.
ALTER TABLE users ADD COLUMN is_bot boolean NOT NULL DEFAULT false;

-- The bot that was already here played the middle level's way, and keeps its games.
UPDATE users SET is_bot = true, name = 'Medium bot'
 WHERE id = '00000000-0000-0000-0000-00000000b07a';

-- The ids are also `Level::user` in `src/bot.rs`; keep them the same. Like the first bot they
-- have no access token, so nobody can sign in as them.
INSERT INTO users (id, access_token, name, is_bot) VALUES
    ('00000000-0000-0000-0000-00000000b07b', NULL, 'Easy bot', true),
    ('00000000-0000-0000-0000-00000000b07c', NULL, 'Hard bot', true);

-- A handful of rows among all the users, so only they are indexed.
CREATE INDEX users_is_bot ON users (id) WHERE is_bot;
