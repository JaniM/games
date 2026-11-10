use serde_json::{Value, json};

use super::rules::{self, ALL, CELLS};
use super::*;
use crate::game::Games;

// --- Helpers ---

/// Seat 0 is Red in every state the tests write down by hand.
const RED: usize = 0;
const BLUE: usize = 1;

fn fresh(red: usize) -> State {
    State::reached(Position::new(red))
}

/// The column and row of a cell named as in the doc: `a1` is column 0, row 0.
fn at(name: &str) -> (usize, usize) {
    let column = usize::from(name.as_bytes()[0] - b'a');
    let row: usize = name[1..].parse().expect("a row number");
    assert!(
        column < SIZE && (1..=SIZE).contains(&row),
        "{name} is not on the board"
    );
    (column, row - 1)
}

/// The action that a move is written as: a cell's name, or `swap`.
fn action(name: &str) -> Action {
    if name == "swap" {
        return Action::Swap;
    }
    let (column, row) = at(name);
    Action::Place { column, row }
}

/// The player to move plays `name`.
fn make(state: &State, name: &str) -> Result<State, Rejection> {
    Hex::apply(state, state.position.turn, action(name))
}

/// Plays the moves one after the other, each by the player to move.
fn play(state: &State, moves: &str) -> State {
    moves.split_whitespace().fold(state.clone(), |state, name| {
        make(&state, name).unwrap_or_else(|err| panic!("{name} was refused: {}", err.reason()))
    })
}

fn stone(state: &State, name: &str) -> Option<usize> {
    let (column, row) = at(name);
    state.position.cells[row * SIZE + column]
}

/// A game that is on, written down by hand: Red's stones and Blue's, by name. Seat 0 is Red, no
/// swap was played, and the stones say whose turn it is. `last` is the stone placed last, which
/// must be one of the player who moved last.
fn position(red: &str, blue: &str, last: Option<&str>) -> State {
    let mut cells = vec![None; SIZE * SIZE];
    for (stones, seat) in [(red, RED), (blue, BLUE)] {
        for name in stones.split_whitespace() {
            let (column, row) = at(name);
            cells[row * SIZE + column] = Some(seat);
        }
    }
    let reds = red.split_whitespace().count();
    let blues = blue.split_whitespace().count();
    let to_move = if reds == blues { RED } else { BLUE };
    State::try_from(Position {
        size: SIZE,
        red: RED,
        cells,
        turn: to_move,
        swapped: false,
        last: last.map(|name| {
            let (column, row) = at(name);
            Last {
                seat: 1 - to_move,
                column,
                row,
                swap: false,
            }
        }),
        phase: Phase::Play,
    })
    .expect("a position that could happen")
}

fn reread(state: &State) -> State {
    serde_json::from_value(serde_json::to_value(state).unwrap()).unwrap()
}

fn reason(result: Result<State, Rejection>) -> String {
    result.expect_err("the move is refused").reason().to_owned()
}

fn over(state: &State) -> Phase {
    assert!(Hex::is_over(state), "the game is not over");
    state.position.phase
}

fn won_by(winner: usize) -> Phase {
    Phase::Over {
        winner,
        forfeited: false,
    }
}

fn forfeited(winner: usize) -> Phase {
    Phase::Over {
        winner,
        forfeited: true,
    }
}

/// The names of the cells of a set, in reading order.
fn names(set: Bits) -> Vec<String> {
    rules::cells_of(set)
        .map(|cell| {
            let (column, row) = rules::place(cell);
            format!("{}{}", (b'a' + column as u8) as char, row + 1)
        })
        .collect()
}

fn bits(names: &str) -> Bits {
    names.split_whitespace().fold(0, |set, name| {
        let (column, row) = at(name);
        set | rules::bit(rules::index(column, row))
    })
}

/// Red holds f1 to f10 and is to move: f11 or e11 wins. Blue has stones down column a.
fn red_about_to_win() -> State {
    position(
        "f1 f2 f3 f4 f5 f6 f7 f8 f9 f10",
        "a1 a2 a3 a4 a5 a6 a7 a8 a9 a10",
        Some("a10"),
    )
}

// --- The board (Coordinates, examples 1 and 2) ---

#[test]
fn a_cell_touches_the_six_the_doc_lists_and_no_others() {
    // Example 1.
    let around = |name: &str| {
        let (column, row) = at(name);
        names(rules::around(rules::bit(rules::index(column, row))))
    };

    assert_eq!(around("f6"), ["f5", "g5", "e6", "g6", "e7", "f7"]);
    assert_eq!(around("a1"), ["b1", "a2"]);
    assert_eq!(around("k1"), ["j1", "j2", "k2"]);
    assert_eq!(around("a11"), ["a10", "b10", "b11"]);
    assert_eq!(around("k11"), ["k10", "j11"]);
    assert_eq!(around("c1").len(), 4, "a cell of an edge has four");
}

#[test]
fn every_cell_has_as_many_neighbours_as_the_doc_says() {
    let mut counts = [0; 7];
    for cell in 0..CELLS {
        counts[rules::around(rules::bit(cell)).count_ones() as usize] += 1;
    }
    // Two acute corners, two obtuse ones, 36 other cells of the edges, and 81 inner ones.
    assert_eq!(counts, [0, 0, 2, 2, 36, 0, 81]);
}

#[test]
fn neighbours_are_neighbours_both_ways() {
    for cell in 0..CELLS {
        for other in rules::cells_of(rules::around(rules::bit(cell))) {
            assert!(rules::around(rules::bit(other)) & rules::bit(cell) != 0);
            assert_ne!(other, cell);
        }
    }
}

#[test]
fn the_mirror_exchanges_column_and_row_and_keeps_neighbours_neighbours() {
    let mirror = |name: &str| {
        let (column, row) = at(name);
        names(rules::bit(rules::mirror(rules::index(column, row))))
    };
    assert_eq!(mirror("a3"), ["c1"]);
    assert_eq!(mirror("d5"), ["e4"]);
    assert_eq!(mirror("f6"), ["f6"]);

    for cell in 0..CELLS {
        let mirrored: Bits = rules::cells_of(rules::around(rules::bit(cell)))
            .fold(0, |set, other| set | rules::bit(rules::mirror(other)));
        assert_eq!(mirrored, rules::around(rules::bit(rules::mirror(cell))));
        assert_eq!(rules::mirror(rules::mirror(cell)), cell);
    }
    // Red's edges become Blue's.
    let mirror_set =
        |set: Bits| rules::cells_of(set).fold(0, |m, c| m | rules::bit(rules::mirror(c)));
    assert_eq!(mirror_set(rules::ROW_FIRST), rules::COL_FIRST);
    assert_eq!(mirror_set(rules::ROW_LAST), rules::COL_LAST);
}

#[test]
fn two_stones_a_bridge_apart_are_not_connected() {
    // Example 2: e5 and f6 don't touch, and become one chain through f5 or e6.
    let apart = bits("e5 f6");
    assert_eq!(rules::flood(bits("e5"), apart), bits("e5"));
    for between in ["f5", "e6"] {
        let joined = apart | bits(between);
        assert_eq!(
            rules::flood(bits("e5"), joined),
            joined,
            "through {between}"
        );
    }
}

// --- A new game, and placing stones ---

#[test]
fn a_new_game_has_an_empty_board_and_red_to_move_anywhere() {
    for red in [0, 1] {
        let game = fresh(red);

        assert_eq!(game.position.turn, red);
        assert!(game.position.cells.iter().all(Option::is_none));
        assert_eq!(game.position.last, None);
        assert!(!game.can_swap);
        assert_eq!(game.chain, None);
        assert!(!Hex::is_over(&game));
    }
}

#[test]
fn the_json_of_a_new_game() {
    let value = serde_json::to_value(fresh(1)).unwrap();

    assert_eq!(
        value,
        json!({
            "size": 11,
            "red": 1,
            "cells": vec![Value::Null; 121],
            "turn": 1,
            "swapped": false,
            "last": null,
            "phase": { "type": "play" },
            "canSwap": false,
            "chain": null,
        })
    );
}

#[test]
fn the_json_of_a_game_in_progress() {
    let game = play(&fresh(0), "b1");

    let value = serde_json::to_value(&game).unwrap();

    assert_eq!(
        value["cells"][1],
        json!(0),
        "b1 is the second cell of the first row"
    );
    assert_eq!(value["turn"], json!(1));
    assert_eq!(
        value["last"],
        json!({ "seat": 0, "column": 1, "row": 0, "swap": false })
    );
    assert_eq!(value["canSwap"], json!(true));
}

#[test]
fn the_game_picks_either_seat_as_red_when_it_starts() {
    let reds: std::collections::HashSet<usize> =
        (0..64).map(|_| Hex::start().position.red).collect();

    assert_eq!(reds, [0, 1].into_iter().collect());
    let game = Hex::start();
    assert_eq!(game.position.turn, game.position.red, "Red moves first");
}

#[test]
fn the_first_stone_may_go_anywhere_and_the_turns_alternate() {
    for name in ["a1", "f6", "k11", "k1"] {
        let game = play(&fresh(0), name);

        assert_eq!(stone(&game, name), Some(RED));
        assert_eq!(game.position.turn, BLUE);
    }
    let game = play(&fresh(1), "f6 e5 d4");
    assert_eq!(stone(&game, "f6"), Some(1));
    assert_eq!(stone(&game, "e5"), Some(0));
    assert_eq!(stone(&game, "d4"), Some(1));
    assert_eq!(game.position.turn, 0);
    assert_eq!(
        game.position.last,
        Some(Last {
            seat: 1,
            column: 3,
            row: 3,
            swap: false
        })
    );
}

#[test]
fn a_taken_cell_is_refused() {
    let game = play(&fresh(0), "f6");

    assert_eq!(reason(make(&game, "f6")), "that cell is already taken");
}

#[test]
fn it_is_not_your_turn_unless_you_are_the_player_to_move() {
    let game = fresh(0);

    assert_eq!(reason(Hex::apply(&game, 1, action("f6"))), "not your turn");
    assert_eq!(reason(Hex::apply(&game, 2, action("f6"))), "not your turn");
}

#[test]
fn a_cell_that_does_not_exist_is_refused() {
    for (column, row) in [(11, 0), (0, 11), (usize::MAX, 3)] {
        assert_eq!(
            reason(fresh(0).act(0, Action::Place { column, row })),
            "there is no such cell"
        );
    }
}

#[test]
fn actions_are_read_from_json() {
    let place: Action =
        serde_json::from_value(json!({ "type": "place", "column": 3, "row": 4 })).unwrap();
    let swap: Action = serde_json::from_value(json!({ "type": "swap" })).unwrap();

    assert_eq!(place, Action::Place { column: 3, row: 4 });
    assert_eq!(swap, Action::Swap);
    for wrong in [
        json!({ "type": "pass" }),
        json!({ "type": "undo" }),
        json!({ "type": "place", "column": 3 }),
        json!({ "type": "place", "column": -1, "row": 0 }),
    ] {
        assert!(
            serde_json::from_value::<Action>(wrong.clone()).is_err(),
            "{wrong}"
        );
    }
}

#[test]
fn a_refused_move_leaves_the_game_as_it_was() {
    let game = play(&fresh(0), "f6");
    let before = game.clone();

    let _ = make(&game, "f6");
    let _ = Hex::apply(&game, 0, action("a1"));

    assert_eq!(game, before);
}

// --- The swap (D3, D4, examples 3 to 6) ---

#[test]
fn blue_may_swap_on_blues_first_turn_and_red_takes_the_mirror_cell_into_account() {
    // Example 3: Red opens on d5; the swap empties d5 and puts Blue's stone on e4.
    let game = play(&fresh(0), "d5");
    assert!(game.can_swap);

    let swapped = play(&game, "swap");

    assert_eq!(stone(&swapped, "d5"), None);
    assert_eq!(stone(&swapped, "e4"), Some(BLUE));
    assert_eq!(swapped.position.cells.iter().flatten().count(), 1);
    assert_eq!(swapped.position.turn, RED, "Red moves next");
    assert_eq!(swapped.position.red, RED, "nobody changes colour");
    assert!(swapped.position.swapped);
    assert!(!swapped.can_swap);
    assert_eq!(
        swapped.position.last,
        Some(Last {
            seat: BLUE,
            column: 4,
            row: 3,
            swap: true
        })
    );
}

#[test]
fn a_swap_of_a_stone_on_the_long_diagonal_only_changes_its_colour() {
    // Example 4.
    let swapped = play(&fresh(1), "f6 swap");

    assert_eq!(stone(&swapped, "f6"), Some(0), "seat 0 is Blue here");
    assert_eq!(swapped.position.turn, 1);
}

#[test]
fn the_swap_from_hexwiki_moves_a3_to_c1() {
    // Example 5.
    let swapped = play(&fresh(0), "a3 swap");

    assert_eq!(stone(&swapped, "a3"), None);
    assert_eq!(stone(&swapped, "c1"), Some(BLUE));
}

#[test]
fn placing_gives_up_the_swap_for_good() {
    // Example 6.
    let game = play(&fresh(0), "a1 f6");
    let refusal = "the swap is only for Blue's first turn, instead of placing a stone";

    assert!(!game.can_swap);
    assert_eq!(reason(make(&game, "swap")), refusal);
    let later = play(&game, "b2");
    assert_eq!(later.position.turn, BLUE);
    assert_eq!(reason(make(&later, "swap")), refusal);
}

#[test]
fn red_can_never_swap_and_there_is_only_one_swap() {
    let refusal = "the swap is only for Blue's first turn, instead of placing a stone";
    assert_eq!(reason(make(&fresh(0), "swap")), refusal);

    let swapped = play(&fresh(0), "d5 swap");
    assert_eq!(reason(make(&swapped, "swap")), refusal);
    let on = play(&swapped, "f6");
    assert!(!on.can_swap);
    assert_eq!(reason(make(&on, "swap")), refusal);
}

#[test]
fn after_a_swap_the_turns_alternate_and_the_cells_are_free_again() {
    let game = play(&fresh(0), "d5 swap d5 c3");

    assert_eq!(
        stone(&game, "d5"),
        Some(RED),
        "Red may take the emptied cell back"
    );
    assert_eq!(stone(&game, "e4"), Some(BLUE));
    assert_eq!(stone(&game, "c3"), Some(BLUE));
    assert_eq!(game.position.turn, RED);
    assert!(!game.position.last.unwrap().swap);
    assert_eq!(reread(&game), game);
}

#[test]
fn a_swap_is_refused_after_the_game() {
    let game = play(&fresh(0), "f6").forfeit(1).unwrap();

    assert_eq!(reason(make(&game, "swap")), "the game is over");
}

// --- Winning (examples 7 to 11) ---

#[test]
fn a_chain_from_top_to_bottom_wins_for_red_at_once() {
    // Example 7.
    let before = red_about_to_win();
    assert_eq!(before.position.turn, RED);

    let after = make(&before, "f11").unwrap();

    assert_eq!(over(&after), won_by(RED));
    assert_eq!(
        after.position.turn, RED,
        "a winning move doesn't pass the turn"
    );
    let chain: Vec<(usize, usize)> = after
        .chain
        .clone()
        .unwrap()
        .iter()
        .map(|cell| (cell.column, cell.row))
        .collect();
    assert_eq!(chain, (0..SIZE).map(|row| (5, row)).collect::<Vec<_>>());
    assert_eq!(reason(make(&after, "k11")), "the game is over");
}

#[test]
fn the_other_way_down_wins_too() {
    let after = make(&red_about_to_win(), "e11").unwrap();

    assert_eq!(over(&after), won_by(RED));
}

#[test]
fn a_red_chain_along_blues_edge_still_wins_for_red() {
    // Example 8.
    let red: Vec<String> = (1..=SIZE).map(|row| format!("a{row}")).collect();
    let blue: Vec<String> = (1..SIZE).map(|row| format!("c{row}")).collect();
    let before = position(&red[..10].join(" "), &blue.join(" "), Some("c10"));

    let after = make(&before, "a11").unwrap();

    assert_eq!(over(&after), won_by(RED));
}

#[test]
fn the_corners_count_for_both_players() {
    // Example 9: Blue fills the top row, Red's edge, and connects the left edge to the right one.
    let blue: Vec<String> = (b'a'..=b'j').map(|c| format!("{}1", c as char)).collect();
    let red: Vec<String> = (b'a'..=b'k').map(|c| format!("{}5", c as char)).collect();
    let before = position(&red.join(" "), &blue.join(" "), Some("k5"));
    assert_eq!(before.position.turn, BLUE);

    let after = make(&before, "k1").unwrap();

    assert_eq!(over(&after), won_by(BLUE));
    assert_eq!(after.chain.as_ref().map(Vec::len), Some(SIZE));
}

#[test]
fn a_chain_between_the_wrong_edges_does_not_win() {
    // Example 10: Red's middle row touches Blue's edges only.
    let before = position(
        "a6 b6 c6 d6 e6 f6 g6 h6 i6 j6",
        "b1 b2 b3 b4 b5 b7 b8 b9 b10 b11",
        Some("b11"),
    );
    assert_eq!(before.position.turn, RED);

    let after = make(&before, "k6").unwrap();

    assert!(!Hex::is_over(&after));
    assert_eq!(after.position.turn, BLUE);
}

#[test]
fn the_winning_chain_is_the_whole_chain_with_its_branches() {
    // Red's chain down column f has a branch to g3, which is part of it, and a stone apart at k5,
    // which is not.
    let before = position(
        "f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 g3 k5",
        "a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11 b1",
        Some("b1"),
    );

    let after = make(&before, "f11").unwrap();

    let chain = after.chain.unwrap();
    assert_eq!(chain.len(), 12);
    assert!(chain.contains(&Cell { column: 6, row: 2 }));
    assert!(!chain.contains(&Cell { column: 10, row: 4 }));
}

#[test]
fn every_way_of_filling_the_board_has_exactly_one_winner() {
    // The hex theorem, which is why there are no draws: whatever the colours of a full board, one
    // player and only one has connected.
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    for _ in 0..500 {
        let mut red: Bits = 0;
        for cell in 0..CELLS {
            if Rng::below(&mut rng, 2) == 0 {
                red |= rules::bit(cell);
            }
        }
        let blue = ALL & !red;
        assert_ne!(
            rules::connected(red, rules::Colour::Red),
            rules::connected(blue, rules::Colour::Blue)
        );
    }
}

// --- Forfeit (D9, examples 12 and 13) ---

#[test]
fn a_forfeit_before_the_first_move_gives_the_other_player_the_win() {
    for red in [0, 1] {
        for seat in [0, 1] {
            let after = fresh(red).forfeit(seat).unwrap();

            assert_eq!(over(&after), forfeited(1 - seat));
            assert_eq!(
                after.position.turn, red,
                "a forfeit doesn't change the turn"
            );
            assert_eq!(after.chain, None);
            assert!(!after.can_swap);
        }
    }
}

#[test]
fn blue_can_give_up_instead_of_choosing_whether_to_swap() {
    // Example 13.
    let game = play(&fresh(0), "f6");

    let after = game.forfeit(BLUE).unwrap();

    assert_eq!(over(&after), forfeited(RED));
    assert!(!after.can_swap);
    assert_eq!(after.position.cells, game.position.cells);
    assert_eq!(after.position.last, game.position.last);
}

#[test]
fn either_player_can_forfeit_on_either_turn_and_the_one_ahead_loses_all_the_same() {
    // Example 12: Red is one stone from winning, and either may give up.
    let game = red_about_to_win();

    assert_eq!(over(&game.forfeit(RED).unwrap()), forfeited(BLUE));
    assert_eq!(over(&game.forfeit(BLUE).unwrap()), forfeited(RED));
}

#[test]
fn a_forfeit_has_no_chain_and_its_json_says_who_gave_up() {
    let after = fresh(0).forfeit(1).unwrap();

    let value = serde_json::to_value(&after).unwrap();

    assert_eq!(
        value["phase"],
        json!({ "type": "over", "winner": 0, "forfeited": true })
    );
    assert_eq!(value["chain"], json!(null));
}

#[test]
fn a_game_that_is_over_cannot_be_given_up() {
    let given_up = fresh(0).forfeit(0).unwrap();
    let won = make(&red_about_to_win(), "f11").unwrap();

    for game in [&given_up, &won] {
        for seat in [0, 1] {
            assert_eq!(reason(game.forfeit(seat)), "the game is over");
        }
    }
}

#[test]
fn only_the_two_seats_can_forfeit() {
    assert_eq!(reason(fresh(0).forfeit(2)), "there is no such seat");
}

// --- Record and reading ---

fn engine() -> std::sync::Arc<dyn crate::game::Engine> {
    Games::default()
        .with::<Hex>()
        .get(Hex::KIND)
        .unwrap()
        .clone()
}

#[test]
fn the_game_is_registered_with_its_constants() {
    let engine = engine();

    assert_eq!(engine.kind(), "hex");
    assert_eq!(engine.name(), "Hex");
    assert_eq!(engine.players(), 2);
    assert_eq!(engine.state_version(), 1);
    // There is no computer opponent for Hex.
    assert!(!engine.has_bot());
    assert!(crate::game::registry().get("hex").is_some());
}

#[test]
fn a_record_is_the_whole_state_and_loads_to_the_same_state() {
    let games = [
        fresh(1),
        play(&fresh(0), "f6"),
        play(&fresh(0), "d5 swap"),
        play(&fresh(0), "d5 swap c3 c4"),
        make(&red_about_to_win(), "f11").unwrap(),
        fresh(0).forfeit(1).unwrap(),
    ];
    for game in games {
        let record = Hex::record(&game).unwrap();
        assert_eq!(record, serde_json::to_value(&game).unwrap());

        let loaded = engine().load(1, record.clone()).expect("the record loads");

        assert_eq!(loaded.to_record().as_ref(), Ok(&record));
        assert_eq!(engine().history_view(record.clone()).as_ref(), Ok(&record));
        assert_eq!(serde_json::from_value::<State>(record).unwrap(), game);
    }
}

#[test]
fn a_state_is_read_with_or_without_what_is_derived() {
    let game = play(&fresh(0), "f6");
    let full = serde_json::to_value(&game).unwrap();
    let mut bare = full.clone();
    for field in ["canSwap", "chain"] {
        bare.as_object_mut().unwrap().remove(field);
    }

    assert_eq!(serde_json::from_value::<State>(full).unwrap(), game);
    assert_eq!(serde_json::from_value::<State>(bare).unwrap(), game);
}

#[test]
fn the_derived_fields_are_worked_out_again_and_never_trusted() {
    let game = play(&fresh(0), "f6 e5");
    let mut value = serde_json::to_value(&game).unwrap();
    value["canSwap"] = json!(true);
    value["chain"] = json!([{ "column": 5, "row": 5 }]);

    let read: State = serde_json::from_value(value).unwrap();

    assert_eq!(read, game);
    assert!(!read.can_swap);
    assert_eq!(read.chain, None);
}

// --- Validation of a position that is read ---

fn refused(position: Position) -> String {
    State::try_from(position).expect_err("the position is refused")
}

fn swapped_once() -> Position {
    play(&fresh(0), "d5 swap").position
}

#[test]
fn positions_that_could_happen_are_accepted() {
    for moves in [
        "",
        "f6",
        "f6 swap",
        "f6 swap a1",
        "f6 swap a1 b2",
        "f6 a1 b2",
    ] {
        let game = play(&fresh(0), moves);
        assert_eq!(State::try_from(game.position.clone()), Ok(game), "{moves}");
    }
}

#[test]
fn stones_must_alternate_starting_with_red() {
    let mut two_reds = play(&fresh(0), "f6 a1 b2").position;
    let (column, row) = at("a1");
    two_reds.cells[row * SIZE + column] = Some(RED);
    two_reds.last = None;
    assert!(refused(two_reds).contains("alternate"));

    let mut blue_first = fresh(0).position;
    blue_first.cells[0] = Some(BLUE);
    blue_first.turn = RED;
    assert!(refused(blue_first).contains("alternate"));
}

#[test]
fn after_a_swap_blue_is_the_one_ahead() {
    // Swapped, with as many stones each: Blue to move, which is fine.
    let game = play(&fresh(0), "d5 swap a1");
    assert_eq!(game.position.turn, BLUE);

    // Not swapped, and Blue ahead, is not.
    let mut not_swapped = swapped_once();
    not_swapped.swapped = false;
    assert!(refused(not_swapped).contains("alternate"));

    // Swapped, with no stones at all, is not either.
    let mut nothing = fresh(0).position;
    nothing.swapped = true;
    assert!(refused(nothing).contains("alternate"));
}

#[test]
fn the_turn_must_be_the_player_whose_move_it_is() {
    let mut game = play(&fresh(0), "f6").position;
    game.turn = RED;
    assert_eq!(refused(game), "it is the other player's turn");

    let mut swapped = swapped_once();
    swapped.turn = BLUE;
    assert_eq!(refused(swapped), "it is the other player's turn");
}

#[test]
fn the_board_is_11_by_11_and_its_cells_are_as_many_as_the_size_says() {
    // Example: a 13 by 13 board, which is a size the rules of this server don't play yet.
    let mut bigger = fresh(0).position;
    bigger.size = 13;
    bigger.cells = vec![None; 13 * 13];
    assert_eq!(
        refused(bigger),
        "a board 13 by 13 is not one this server plays: only 11 by 11"
    );

    let mut short = fresh(0).position;
    short.cells.pop();
    assert_eq!(
        refused(short),
        "there are 120 cells, not the 121 of a board 11 by 11"
    );

    let mut long = fresh(0).position;
    long.cells.push(None);
    assert!(refused(long).contains("there are 122 cells"));
}

#[test]
fn a_state_without_a_size_is_not_one_of_this_layout() {
    let mut value = serde_json::to_value(fresh(0)).unwrap();
    value.as_object_mut().unwrap().remove("size");

    assert!(serde_json::from_value::<State>(value.clone()).is_err());
    assert!(engine().load(1, value).is_err());
}

#[test]
fn seats_must_be_0_or_1() {
    let mut red = fresh(0).position;
    red.red = 2;
    assert_eq!(refused(red), "a seat is 0 or 1");

    let mut stone = play(&fresh(0), "f6").position;
    stone.cells[5 * SIZE + 5] = Some(2);
    assert!(refused(stone).contains("not 0 or 1"));
}

#[test]
fn the_last_move_must_be_there_and_be_the_last_players() {
    let mut missing = play(&fresh(0), "f6").position;
    missing.last = None;
    assert_eq!(refused(missing), "there are stones but no last move");

    let mut extra = fresh(0).position;
    extra.last = Some(Last {
        seat: RED,
        column: 0,
        row: 0,
        swap: false,
    });
    assert_eq!(refused(extra), "there is a last move but no stones");

    let mut elsewhere = play(&fresh(0), "f6").position;
    elsewhere.last = Some(Last {
        seat: RED,
        column: 0,
        row: 0,
        swap: false,
    });
    assert!(refused(elsewhere).contains("not a stone of the player who moved last"));

    let mut off_board = play(&fresh(0), "f6").position;
    off_board.last = Some(Last {
        seat: RED,
        column: 11,
        row: 0,
        swap: false,
    });
    assert_eq!(refused(off_board), "the last stone is not on the board");
}

#[test]
fn the_last_move_is_a_swap_exactly_until_red_answers_it() {
    let mut not_marked = swapped_once();
    not_marked.last.as_mut().unwrap().swap = false;
    assert!(refused(not_marked).contains("swap"));

    let mut marked_late = play(&fresh(0), "d5 swap a1").position;
    marked_late.last.as_mut().unwrap().swap = true;
    assert!(refused(marked_late).contains("swap"));

    let mut never_swapped = play(&fresh(0), "f6").position;
    never_swapped.last.as_mut().unwrap().swap = true;
    assert!(refused(never_swapped).contains("swap"));
}

#[test]
fn a_game_that_has_been_won_cannot_still_be_played_and_the_winner_must_be_right() {
    let won = make(&red_about_to_win(), "f11").unwrap().position;

    let mut still_on = won.clone();
    still_on.phase = Phase::Play;
    assert_eq!(
        refused(still_on),
        "the game has ended, but is still being played"
    );

    let mut wrong_winner = won.clone();
    wrong_winner.phase = won_by(BLUE);
    assert!(refused(wrong_winner).contains("winner"));

    let mut given_up = won.clone();
    given_up.phase = forfeited(BLUE);
    assert_eq!(refused(given_up), "a game that had ended was given up");

    let mut turn_passed = won;
    turn_passed.turn = BLUE;
    assert!(refused(turn_passed).contains("stays their turn"));
}

#[test]
fn a_win_needs_a_connection_and_a_forfeit_leaves_the_turn() {
    let mut no_chain = play(&fresh(0), "f6").position;
    no_chain.phase = won_by(RED);
    no_chain.turn = RED;
    assert!(refused(no_chain).contains("connected"));

    let mut forfeit_turn = play(&fresh(0), "f6").position;
    forfeit_turn.phase = forfeited(RED);
    forfeit_turn.turn = RED;
    assert!(refused(forfeit_turn).contains("whose turn"));
}

#[test]
fn a_state_that_could_not_happen_fails_to_load() {
    let mut value = serde_json::to_value(play(&fresh(0), "f6")).unwrap();
    value["turn"] = json!(0);

    assert!(engine().load(1, value).is_err());
    assert!(engine().load(1, json!({ "red": 0 })).is_err());
    let mut short = serde_json::to_value(fresh(0)).unwrap();
    short["cells"] = json!(vec![Value::Null; 120]);
    assert!(engine().load(1, short).is_err());
    let mut bigger = serde_json::to_value(fresh(0)).unwrap();
    bigger["size"] = json!(13);
    bigger["cells"] = json!(vec![Value::Null; 13 * 13]);
    assert!(engine().load(1, bigger).is_err());
    // Rows of cells are not the layout either.
    let mut rows = serde_json::to_value(fresh(0)).unwrap();
    rows["cells"] = json!(vec![vec![Value::Null; 11]; 11]);
    let bigger = rows;
    assert!(engine().load(1, bigger).is_err());
}

// --- Whole games ---

/// A small, fixed random number generator for the tests that play whole games.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() >> 11) as usize % n
    }
}

/// Every move the player to move may make.
fn legal(state: &State) -> Vec<Action> {
    let mut moves = Vec::new();
    for row in 0..SIZE {
        for column in 0..SIZE {
            if state.position.cells[row * SIZE + column].is_none() {
                moves.push(Action::Place { column, row });
            }
        }
    }
    if state.can_swap {
        moves.push(Action::Swap);
    }
    moves
}

/// Plays a game to its end, every move one of the legal ones at random, checking the rules as it
/// goes. A game is at most 121 stones, and the swap is one more move.
fn play_out(red: usize, rng: &mut Rng) -> State {
    let mut game = fresh(red);
    let mut moves = 0;
    while game.position.phase == Phase::Play {
        let options = legal(&game);
        assert!(!options.is_empty(), "a game that is on always has a move");
        let seat = game.position.turn;
        let action = options[rng.below(options.len())];
        assert!(options.contains(&action), "{action:?} is not legal");
        game = Hex::apply(&game, seat, action).expect("a legal move is accepted");
        moves += 1;
        assert!(moves <= CELLS + 1, "the game does not end");
    }
    assert_eq!(reread(&game), game, "a state reads back as it was");
    game
}

#[test]
fn random_games_always_end_with_a_winner_and_never_break_the_rules() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut wins = [0; 2];
    for game in 0..300 {
        let end = play_out(game % 2, &mut rng);
        match over(&end) {
            Phase::Over {
                winner,
                forfeited: false,
            } => {
                assert!(end.chain.as_ref().is_some_and(|chain| !chain.is_empty()));
                wins[winner] += 1;
            }
            other => panic!("{other:?}"),
        }
    }
    assert!(wins[0] > 100 && wins[1] > 100, "{wins:?}");
}
