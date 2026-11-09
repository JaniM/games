-- A registered user's name is their username. It is the name other players see, so the names
-- of registered users are as unique as usernames are (`users_username_lower_key`). A guest
-- still has a free-form name, or none, which the clients show with a guest indicator.
--
-- An account made before this had whatever display name its owner had picked.
UPDATE users SET name = username WHERE username IS NOT NULL AND name IS DISTINCT FROM username;

-- Not `name = username` alone: that is not false when `name` is null.
ALTER TABLE users
    ADD CONSTRAINT users_account_name_is_username
    CHECK (username IS NULL OR name IS NOT DISTINCT FROM username);
