//! The id of a game. It is also the game's invite link, so it has to be short enough to
//! share and long enough that nobody finds a game by guessing.
//!
//! A new id is [`LENGTH`] characters, each one of 32, picked at random: 60 bits. The letters
//! `l` and `o` and the digits `0` and `1` are left out because they are easily mistaken for
//! each other, and the rest is lower case so that there is only one way to write an id.
//!
//! Games made before ids were short have a uuid for an id, written as text. Those are still
//! valid ids: an id is anything of the right alphabet and at most a uuid long.

use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize};

/// The characters of a new id. Exactly 32, so that a random byte's low five bits pick one
/// of them without favouring any.
const ALPHABET: &[u8; 32] = b"abcdefghijkmnpqrstuvwxyz23456789";

/// How many characters a new id has.
pub const LENGTH: usize = 12;

/// The longest id there is: a uuid with its dashes.
const MAX_LENGTH: usize = 36;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, sqlx::Type)]
#[serde(transparent)]
#[sqlx(transparent)]
pub struct GameId(String);

/// Not an id of a game that could exist.
#[derive(Debug, PartialEq, Eq)]
pub struct InvalidGameId;

impl fmt::Display for InvalidGameId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("not a game id")
    }
}

impl GameId {
    /// A new random id. It may already be taken, which the database settles.
    pub fn random() -> Result<Self, getrandom::Error> {
        let mut bytes = [0; LENGTH];
        getrandom::fill(&mut bytes)?;
        let id = bytes
            .iter()
            .map(|byte| char::from(ALPHABET[usize::from(byte & 31)]))
            .collect();
        Ok(Self(id))
    }
}

impl FromStr for GameId {
    type Err = InvalidGameId;

    /// Checks that `text` can be an id, without checking that there is a game with it.
    fn from_str(text: &str) -> Result<Self, InvalidGameId> {
        let fits = (1..=MAX_LENGTH).contains(&text.len())
            && text
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
        if fits {
            Ok(Self(text.to_owned()))
        } else {
            Err(InvalidGameId)
        }
    }
}

impl<'de> Deserialize<'de> for GameId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(serde::de::Error::custom)
    }
}

impl fmt::Display for GameId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn a_new_id_is_short_and_made_of_the_alphabet() {
        for _ in 0..200 {
            let id = GameId::random().unwrap();

            assert_eq!(id.0.len(), LENGTH);
            assert!(id.0.bytes().all(|byte| ALPHABET.contains(&byte)), "{id}");
        }
    }

    #[test]
    fn new_ids_do_not_repeat() {
        let ids: HashSet<_> = (0..1000).map(|_| GameId::random().unwrap()).collect();

        assert_eq!(ids.len(), 1000);
    }

    #[test]
    fn every_character_of_the_alphabet_can_come_up() {
        // 32 characters, 12 at a time: a few hundred ids show them all unless the choice is skewed.
        let seen: HashSet<u8> = (0..500)
            .flat_map(|_| GameId::random().unwrap().0.into_bytes())
            .collect();

        assert_eq!(seen.len(), ALPHABET.len());
    }

    #[test]
    fn an_id_survives_a_trip_through_text_and_json() {
        let id = GameId::random().unwrap();

        assert_eq!(id.to_string().parse(), Ok(id.clone()));
        let json = serde_json::to_value(&id).unwrap();
        assert_eq!(json, serde_json::json!(id.0));
        assert_eq!(serde_json::from_value::<GameId>(json).unwrap(), id);
    }

    #[test]
    fn the_uuid_of_a_game_from_before_short_ids_is_still_an_id() {
        let old = "6f1c2a3e-5b4d-4c8a-9e0f-1a2b3c4d5e6f";

        assert_eq!(
            old.parse::<GameId>().map(|id| id.to_string()),
            Ok(old.to_owned())
        );
    }

    #[test]
    fn text_that_no_id_could_be_is_refused() {
        let too_long = "a".repeat(MAX_LENGTH + 1);
        for text in [
            "",
            "UPPER",
            "with space",
            "slash/",
            "dot.",
            "ünï",
            &too_long,
        ] {
            assert_eq!(text.parse::<GameId>(), Err(InvalidGameId), "{text:?}");
        }
        assert!(serde_json::from_value::<GameId>(serde_json::json!("No!")).is_err());
    }
}
