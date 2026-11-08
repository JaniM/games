-- Whether a game has ended, so that a user's games can be listed as finished without loading
-- each one. The server sets it whenever it saves a state (see `Game::is_over`).
ALTER TABLE games ADD COLUMN finished boolean NOT NULL DEFAULT false;

-- Games that ended before this column existed. Long backgammon is the only game so far, and
-- marks the end in its phase (`{"phase": {"type": "over", ...}}`).
UPDATE games
SET finished = true
WHERE kind = 'long-backgammon' AND state -> 'phase' ->> 'type' = 'over';
