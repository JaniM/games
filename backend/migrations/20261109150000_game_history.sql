-- Every state a game has been in, so that a game can be stepped through afterwards, by its
-- players and by anyone who watches (`GET /api/games/{id}/history`, see `src/history.rs`).
-- `games.state` only ever holds the newest one.
--
-- A row is written in the same transaction as the change that gave the game its state: the
-- last player joining, an action (a player's or the bot's), or a game that is made already
-- started. A change that leaves the state as it is (a rematch being asked for or answered)
-- writes none, and neither does a refused action.
--
-- Games that ended before this table existed have no rows: only their last state was kept,
-- and the earlier ones can't be worked out again because the dice are random.
CREATE TABLE game_history (
    game_id       text    NOT NULL REFERENCES games ON DELETE CASCADE,
    -- The `games.revision` at which the game had this state. They rise but are not
    -- consecutive: a rematch offer takes a revision without giving the game a new state.
    revision      bigint  NOT NULL,
    -- The layout version of `state`, as for `games.state_version`. Rows keep the version they
    -- were written with, and are brought up to date when they are read.
    state_version integer NOT NULL CHECK (state_version >= 1),
    -- The game's record of the state (`Game::record`): the state, without what a game can work
    -- out again from the rest. It is a valid `games.state` of the same layout version.
    state         jsonb   NOT NULL,
    PRIMARY KEY (game_id, revision)
);
