-- Accounts: a username and password on top of an anonymous user (see `src/account.rs`), and the
-- sessions that sign an account in.
--
-- An anonymous user ("guest") is found by `users.access_token`. An account is found by a row in
-- `sessions`, one per browser that signed in, and has no `access_token`: creating the account
-- retires the guest token, so that whoever held it can't get into the account.
ALTER TABLE users
    ADD COLUMN username      text,
    ADD COLUMN password_hash text,
    -- When the user deleted themselves. Their row stays while games they played in refer to it,
    -- with everything that identified them removed.
    ADD COLUMN deleted_at    timestamptz,
    -- Matches `valid_username` in `src/account.rs`.
    ADD CONSTRAINT users_username_format CHECK (username ~ '^[A-Za-z0-9_.-]{3,32}$'),
    ADD CONSTRAINT users_login_complete CHECK ((username IS NULL) = (password_hash IS NULL)),
    ADD CONSTRAINT users_account_has_no_guest_token CHECK (password_hash IS NULL OR access_token IS NULL);

-- Names are unique whatever their case. Users without one (null) don't collide.
CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username));

-- A signed-in browser. The token itself is never stored, only its SHA-256, so reading this table
-- doesn't let anyone in.
CREATE TABLE sessions (
    token_hash   bytea       PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    -- Set when the session is made and whenever the user's profile is read (`GET /api/me`). A
    -- session that hasn't been seen for `SESSION_LIFETIME` (`src/auth.rs`) no longer works.
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id ON sessions (user_id);
-- For sweeping the expired ones.
CREATE INDEX sessions_last_seen_at ON sessions (last_seen_at);

-- For finding the users who deleted themselves and whose last game is gone (`src/account.rs`).
CREATE INDEX users_deleted_at ON users (deleted_at) WHERE deleted_at IS NOT NULL;
