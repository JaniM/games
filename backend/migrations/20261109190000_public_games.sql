-- Whether a game is in the public list (`GET /api/public-games`, see `src/lobby.rs`). The
-- player who makes a game chooses; a rematch is public if the game it follows was.
--
-- A game's id is otherwise its only access control: whoever has it can watch. Listing a game
-- hands its id to everyone, so the list has to be opt-in. Games that exist when this runs were
-- made when only the link opened a game, and stay that way.
ALTER TABLE games ADD COLUMN public boolean NOT NULL DEFAULT false;

-- The list shows the games that have started, newest change first. A game that waits for
-- an opponent isn't listed: its id is an invite to the person it was sent to.
CREATE INDEX games_public ON games (updated_at DESC, id) WHERE public AND state IS NOT NULL;
