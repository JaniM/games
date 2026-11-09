//! The rematch of a finished game: one player asks to play again, and the other answers.
//!
//! A rematch is a **new game** with the same two players in the same seats. The finished game
//! stays as it was, so both players can still look at how it ended, and once the rematch
//! exists it points at it, for anyone who comes back later. Which player is White is decided
//! by the game when it starts, as for any new game.
//!
//! This is the bookkeeping of who asked and who answered, and nothing else. Making the new
//! game, saving it and telling the players is the room's job (see `room`).
//!
//! Against the computer there is nobody to ask: it always says yes.

use serde::{Deserialize, Serialize};

use crate::game_id::GameId;

/// Where a game's rematch stands. A game with no rematch has none of these.
///
/// This is also how clients see it, in the snapshot: `{ "type": "offered", "by": 0 }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Rematch {
    /// The player in seat `by` has asked, and the other player hasn't answered.
    Offered { by: usize },
    /// The other player said no to the offer of the player in seat `by`. Either may ask again.
    Declined { by: usize },
    /// Both want it, and the new game exists. This is final.
    Accepted { game_id: GameId },
}

/// What a request does to the rematch.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Nothing changes: the request asks for what already is.
    Unchanged,
    /// The rematch becomes this; `None` is no rematch at all.
    Becomes(Option<Rematch>),
    /// Both players want it: make the new game, which makes the rematch [`Rematch::Accepted`].
    Start,
}

/// The player in `seat` asks for a rematch, or says yes to the other player's ask. Asking
/// twice is asking once. `opponent_is_bot` says that the other seat is the computer's.
pub fn ask(current: Option<&Rematch>, seat: usize, opponent_is_bot: bool) -> Outcome {
    match current {
        Some(Rematch::Accepted { .. }) => Outcome::Unchanged,
        Some(Rematch::Offered { by }) if *by == seat => Outcome::Unchanged,
        // The other player asked first, so this is the answer.
        Some(Rematch::Offered { .. }) => Outcome::Start,
        None | Some(Rematch::Declined { .. }) if opponent_is_bot => Outcome::Start,
        None | Some(Rematch::Declined { .. }) => {
            Outcome::Becomes(Some(Rematch::Offered { by: seat }))
        }
    }
}

/// The player in `seat` takes back their own ask, or says no to the other player's.
pub fn decline(current: Option<&Rematch>, seat: usize) -> Outcome {
    match current {
        Some(Rematch::Offered { by }) if *by == seat => Outcome::Becomes(None),
        Some(Rematch::Offered { by }) => Outcome::Becomes(Some(Rematch::Declined { by: *by })),
        // Nothing to take back or refuse, and a new game can't be taken back.
        None | Some(Rematch::Declined { .. } | Rematch::Accepted { .. }) => Outcome::Unchanged,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn offered(by: usize) -> Option<Rematch> {
        Some(Rematch::Offered { by })
    }

    fn declined(by: usize) -> Option<Rematch> {
        Some(Rematch::Declined { by })
    }

    fn accepted() -> Option<Rematch> {
        Some(Rematch::Accepted {
            game_id: "nextgame234".parse().unwrap(),
        })
    }

    #[test]
    fn asking_makes_an_offer_to_the_other_player() {
        assert_eq!(ask(None, 0, false), Outcome::Becomes(offered(0)));
        assert_eq!(ask(None, 1, false), Outcome::Becomes(offered(1)));
    }

    #[test]
    fn asking_again_changes_nothing() {
        assert_eq!(ask(offered(0).as_ref(), 0, false), Outcome::Unchanged);
    }

    #[test]
    fn asking_after_the_other_player_asked_is_saying_yes() {
        assert_eq!(ask(offered(1).as_ref(), 0, false), Outcome::Start);
        assert_eq!(ask(offered(0).as_ref(), 1, false), Outcome::Start);
    }

    #[test]
    fn a_player_who_was_turned_down_may_ask_again_and_so_may_the_one_who_said_no() {
        assert_eq!(
            ask(declined(0).as_ref(), 0, false),
            Outcome::Becomes(offered(0))
        );
        assert_eq!(
            ask(declined(0).as_ref(), 1, false),
            Outcome::Becomes(offered(1))
        );
    }

    #[test]
    fn a_rematch_that_has_started_cannot_be_asked_for_again() {
        for seat in [0, 1] {
            assert_eq!(ask(accepted().as_ref(), seat, false), Outcome::Unchanged);
        }
    }

    #[test]
    fn the_computer_says_yes_at_once() {
        assert_eq!(ask(None, 0, true), Outcome::Start);
        assert_eq!(ask(declined(0).as_ref(), 0, true), Outcome::Start);
        // Already started stays started, and an offer that was somehow made is answered.
        assert_eq!(ask(accepted().as_ref(), 0, true), Outcome::Unchanged);
        assert_eq!(ask(offered(1).as_ref(), 0, true), Outcome::Start);
    }

    #[test]
    fn declining_your_own_offer_takes_it_back() {
        assert_eq!(decline(offered(0).as_ref(), 0), Outcome::Becomes(None));
    }

    #[test]
    fn declining_the_other_players_offer_turns_them_down() {
        assert_eq!(
            decline(offered(1).as_ref(), 0),
            Outcome::Becomes(declined(1))
        );
    }

    #[test]
    fn declining_with_nothing_to_decline_changes_nothing() {
        for current in [None, declined(0), declined(1), accepted()] {
            for seat in [0, 1] {
                assert_eq!(decline(current.as_ref(), seat), Outcome::Unchanged);
            }
        }
    }

    #[test]
    fn clients_see_it_as_a_tagged_object_in_camel_case() {
        let json = |rematch: Option<Rematch>| serde_json::to_value(rematch).unwrap();

        assert_eq!(json(offered(1)), json!({ "type": "offered", "by": 1 }));
        assert_eq!(json(declined(0)), json!({ "type": "declined", "by": 0 }));
        assert_eq!(
            json(accepted()),
            json!({ "type": "accepted", "gameId": "nextgame234" })
        );
        assert_eq!(json(None), json!(null));
    }

    #[test]
    fn what_is_stored_reads_back_the_same() {
        for rematch in [offered(0), declined(1), accepted()] {
            let stored = serde_json::to_value(&rematch).unwrap();

            assert_eq!(
                serde_json::from_value::<Option<Rematch>>(stored).unwrap(),
                rematch
            );
        }
    }
}
