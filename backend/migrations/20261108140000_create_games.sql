-- A game room's persistent form. The server keeps a game in memory only while someone
-- is connected to it, and writes every change here before telling the clients.
CREATE TABLE games (
    -- The id is also the invite: anyone who knows it can join a game that has a free seat.
    -- It must stay unguessable, so keep it a random (version 4) uuid. Don't switch to a
    -- time-ordered one (v7) or a serial.
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Which game this is, e.g. 'long-backgammon'. Selects the rules engine.
    kind          text        NOT NULL,
    -- The layout version of `state`, as defined by the game kind. A game that
    -- changes its state format bumps the version and upgrades old rows when it loads them.
    state_version integer     NOT NULL CHECK (state_version >= 1),
    -- The game's own JSON. Null until every seat is taken and the game starts.
    state         jsonb,
    -- Counts the changes since creation (a player joining or an action played).
    -- Writers say which revision they build on, so a stale writer cannot overwrite a newer one.
    revision      bigint      NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Which users are in which games. A row is written together with the join that it records.
CREATE TABLE game_players (
    game_id uuid     NOT NULL REFERENCES games ON DELETE CASCADE,
    -- 0-based, in joining order. The rules engine addresses players by seat.
    seat    smallint NOT NULL CHECK (seat >= 0),
    user_id uuid     NOT NULL REFERENCES users,
    PRIMARY KEY (game_id, seat),
    -- One seat per user per game.
    UNIQUE (game_id, user_id)
);

-- For listing a user's games (`GET /api/games`). The unique key above starts with game_id.
CREATE INDEX game_players_user_id ON game_players (user_id);
