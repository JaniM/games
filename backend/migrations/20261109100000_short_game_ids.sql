-- Game ids become text, so that new ones can be short enough to read out and type: 12
-- random characters (see `src/game_id.rs`). The id is still the invite, so it must stay
-- unguessable: never a serial, and never anything derived from time or from another id.
--
-- Games that already exist keep their uuid, written as text, so their links keep working.
-- The checks keep out ids that no one could have made, so a room is never started for them.
ALTER TABLE game_players DROP CONSTRAINT game_players_game_id_fkey;

-- The default made a uuid. Ids are made by the server now.
ALTER TABLE games ALTER COLUMN id DROP DEFAULT;
ALTER TABLE games ALTER COLUMN id TYPE text USING id::text;
ALTER TABLE games ADD CONSTRAINT games_id_shape CHECK (id ~ '^[0-9a-z-]{1,36}$');

ALTER TABLE game_players ALTER COLUMN game_id TYPE text USING game_id::text;
ALTER TABLE game_players
    ADD CONSTRAINT game_players_game_id_fkey FOREIGN KEY (game_id) REFERENCES games ON DELETE CASCADE;
