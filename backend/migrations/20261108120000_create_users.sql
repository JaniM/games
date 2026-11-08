-- Anonymous accounts: `POST /api/register` creates a row and hands the client a
-- random access token, which the client sends back to authenticate.
CREATE TABLE users (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    access_token text        NOT NULL UNIQUE,
    -- The name a user shows to others. Null until they pick one.
    name         text        CHECK (char_length(name) BETWEEN 1 AND 32),
    created_at   timestamptz NOT NULL DEFAULT now()
);
