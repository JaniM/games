-- A history row may hold what changed since the row before it, instead of the whole state.
--
-- A step of a game changes a few numbers of a state that has dozens, so a delta is about a
-- third of the state's length (some 130 bytes against 330 for long backgammon), and a game of
-- 300 states about half of what it was. See `src/delta.rs` for the format, and `src/history.rs`
-- for when a row is one or the other.
--
-- A row has exactly one of the two:
--
--   state  the state itself: the first row of a game, and the first one a room writes after it
--          loads the game, which is the only time the layout version can change under a game
--   delta  the changes that turn the state of the row with the next lower revision into this
--          one's. Both are of the layout version in `state_version`, which therefore equals
--          that row's.
--
-- Rows that exist when this runs keep their state, so they stay as long as they are.
ALTER TABLE game_history ALTER COLUMN state DROP NOT NULL;
ALTER TABLE game_history ADD COLUMN delta json;
ALTER TABLE game_history
    ADD CONSTRAINT game_history_state_or_delta CHECK ((state IS NULL) <> (delta IS NULL));
