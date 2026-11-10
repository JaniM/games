use serde_json::{Value, json};

use super::rules::{self, LINES};
use super::*;
use crate::game::Games;

// --- Helpers ---

/// Seat 0 is X in every state the tests write down by hand.
const X: usize = 0;
const O: usize = 1;

/// A small board won by X, on the top row, with O's two marks in cells 3 and 4.
const X_WON: &str = "XXX OO. ...";
/// A small board won by O, on the top row, with X's two marks in cells 3 and 4.
const O_WON: &str = "OOO XX. ...";
/// A small board full of marks with no line: 4 X and 5 O.
const DRAWN: &str = "XOX XOO OXO";
/// X holds cells 0 and 4, so cell 8 would win the board; O holds four cells and has no line.
const X_NEEDS_EIGHT: &str = "XO. OXO .O.";

fn fresh(x: usize) -> State {
    State::reached(Position::new(x))
}

fn mark(state: &State, board: usize, cell: usize) -> Result<State, Rejection> {
    UltimateTicTacToe::apply(state, state.position.turn, Action::Play { board, cell })
}

/// Plays the marks one after the other, each by the player to move.
fn play(state: &State, marks: &[(usize, usize)]) -> State {
    marks.iter().fold(state.clone(), |state, &(board, cell)| {
        mark(&state, board, cell)
            .unwrap_or_else(|err| panic!("({board}, {cell}) was refused: {}", err.reason()))
    })
}

/// A game that is on, written down by hand: each listed board as nine characters, `X` for a
/// mark of seat 0, `O` for seat 1 and `.` for an empty cell (spaces are ignored, so that a
/// row can be told from the next). The boards not listed are empty. `last` is the mark placed
/// last: it names the board to play in, and it must be a mark of the player who moved last,
/// which the number of marks decides.
fn position(boards: &[(usize, &str)], last: Option<(usize, usize)>) -> State {
    let mut cells = [[None; 9]; 9];
    for &(board, marks) in boards {
        let marks: Vec<char> = marks.chars().filter(|c| !c.is_whitespace()).collect();
        assert_eq!(marks.len(), 9, "board {board} needs nine cells");
        for (cell, mark) in marks.into_iter().enumerate() {
            cells[board][cell] = match mark {
                'X' => Some(X),
                'O' => Some(O),
                '.' => None,
                other => panic!("{other:?} is not a mark"),
            };
        }
    }
    let played = cells.iter().flatten().flatten().count();
    let to_move = played % 2;
    State::try_from(Position {
        x: X,
        cells,
        turn: to_move,
        last: last.map(|(board, cell)| Last {
            seat: 1 - to_move,
            board,
            cell,
        }),
        phase: Phase::Play,
    })
    .expect("a position that could happen")
}

fn open(state: &State) -> Vec<usize> {
    (0..9)
        .filter(|&b| state.boards[b] == BoardState::Open)
        .collect()
}

fn reread(state: &State) -> State {
    serde_json::from_value(serde_json::to_value(state).unwrap()).unwrap()
}

fn reason(result: Result<State, Rejection>) -> String {
    result.expect_err("the move is refused").reason().to_owned()
}

/// Every move the player to move may make.
fn legal(state: &State) -> Vec<(usize, usize)> {
    let mut moves = Vec::new();
    for &board in &state.playable {
        for cell in 0..9 {
            if state.position.cells[board][cell].is_none() {
                moves.push((board, cell));
            }
        }
    }
    moves
}

fn over(state: &State) -> Phase {
    assert!(UltimateTicTacToe::is_over(state), "the game is not over");
    state.position.phase
}

fn won_by(winner: usize) -> Phase {
    Phase::Over {
        winner: Some(winner),
        forfeited: false,
    }
}

fn forfeited(winner: usize) -> Phase {
    Phase::Over {
        winner: Some(winner),
        forfeited: true,
    }
}

/// X, to move, holds boards 0 and 4 and needs board 8 for the diagonal: it can win the game
/// with cell 8 of board 8, where the last mark (O's, in cell 8 of board 0) has sent it.
fn about_to_win() -> State {
    position(
        &[(0, "XXX O.. ..O"), (4, X_WON), (8, X_NEEDS_EIGHT)],
        Some((0, 8)),
    )
}

// --- A new game ---

#[test]
fn a_new_game_has_nothing_marked_and_x_to_move_anywhere() {
    for x in [0, 1] {
        let game = fresh(x);

        assert_eq!(game.position.x, x);
        assert_eq!(game.position.turn, x);
        assert_eq!(game.position.phase, Phase::Play);
        assert_eq!(game.playable, (0..9).collect::<Vec<_>>());
        assert!(!UltimateTicTacToe::is_over(&game));
    }
}

#[test]
fn the_json_of_a_new_game() {
    let value = serde_json::to_value(fresh(1)).unwrap();

    assert_eq!(
        value,
        json!({
            "x": 1,
            "cells": vec![vec![Value::Null; 9]; 9],
            "turn": 1,
            "last": null,
            "phase": { "type": "play" },
            "boards": vec![json!({ "type": "open" }); 9],
            "playable": [0, 1, 2, 3, 4, 5, 6, 7, 8],
            "line": null,
        })
    );
}

#[test]
fn the_json_of_a_game_in_progress() {
    let game = play(&fresh(0), &[(0, 4)]);

    let value = serde_json::to_value(&game).unwrap();

    assert_eq!(value["turn"], 1);
    assert_eq!(value["last"], json!({ "seat": 0, "board": 0, "cell": 4 }));
    assert_eq!(
        value["cells"][0],
        json!([null, null, null, null, 0, null, null, null, null])
    );
    assert_eq!(value["playable"], json!([4]));
    assert_eq!(value["phase"], json!({ "type": "play" }));
}

#[test]
fn the_json_of_a_game_that_was_won() {
    let won = mark(&about_to_win(), 8, 8).unwrap();

    let value = serde_json::to_value(&won).unwrap();

    assert_eq!(
        value["phase"],
        json!({ "type": "over", "winner": 0, "forfeited": false })
    );
    assert_eq!(value["line"], json!([0, 4, 8]));
    assert_eq!(value["boards"][8], json!({ "type": "won", "seat": 0 }));
    assert_eq!(value["playable"], json!([]));
    assert_eq!(value["last"], json!({ "seat": 0, "board": 8, "cell": 8 }));
}

#[test]
fn the_game_picks_either_seat_as_x_when_it_starts() {
    let seen: Vec<usize> = (0..64)
        .map(|_| UltimateTicTacToe::start().position.x)
        .collect();

    assert!(seen.contains(&0) && seen.contains(&1), "{seen:?}");
}

// --- The sending rule (worked examples 1 to 5 and 10) ---

#[test]
fn the_first_move_may_be_anywhere_and_names_the_next_board() {
    // Example 1: board 1, cell 5 sends the opponent to board 5.
    for x in [0, 1] {
        let after = play(&fresh(x), &[(0, 4)]);

        assert_eq!(after.position.turn, 1 - x);
        assert_eq!(after.playable, vec![4]);
    }
    // Any cell of any board is allowed to begin with.
    for (board, cell) in [(0, 0), (8, 8), (4, 4), (2, 6)] {
        assert!(mark(&fresh(0), board, cell).is_ok(), "({board}, {cell})");
    }
}

#[test]
fn a_mark_in_the_same_cell_as_its_board_sends_the_opponent_back_there() {
    // Example 2: O is in board 5 and marks cell 5, so X must play in board 5 again.
    let after = play(&fresh(0), &[(0, 4), (4, 4)]);

    assert_eq!(after.playable, vec![4]);
    assert_eq!(after.position.turn, X);
}

#[test]
fn a_player_sent_to_a_won_board_may_play_in_any_open_board() {
    // Example 3: board 3 is won by X, and O marks cell 3 of board 7 to send X there. X's last
    // mark was in cell 3 of board 3, which named board 3 for O: O is free too.
    let before = position(&[(2, X_WON)], Some((2, 2)));
    assert_eq!(before.position.turn, O);
    assert_eq!(before.playable, open(&before));

    let after = mark(&before, 6, 2).unwrap();

    assert_eq!(after.boards[2], BoardState::Won { seat: X });
    assert_eq!(after.playable, vec![0, 1, 3, 4, 5, 6, 7, 8]);
    // The won board takes no more moves, though it has empty cells.
    assert_eq!(reason(mark(&after, 2, 5)), "that board is already decided");
    assert!(mark(&after, 8, 0).is_ok());
}

#[test]
fn a_player_sent_to_a_drawn_board_may_play_in_any_open_board() {
    // Example 4: board 6 is full with no line, and the last mark was in cell 6 of board 1.
    // (Here the drawn board is board 5, counted from 0, and the last mark is in cell 5.)
    let state = position(&[(5, DRAWN), (0, "X....X...")], Some((0, 5)));

    assert_eq!(state.boards[5], BoardState::Drawn);
    assert_eq!(state.position.turn, O);
    assert_eq!(state.playable, vec![0, 1, 2, 3, 4, 6, 7, 8]);
    assert!(mark(&state, 7, 7).is_ok());
    assert_eq!(reason(mark(&state, 5, 8)), "that board is already decided");
}

#[test]
fn a_mark_that_closes_its_own_target_leaves_the_opponent_free() {
    // Example 5: X completes the middle row of board 5 by marking its cell 5. The move sends
    // O to board 5, which is now won.
    let before = position(
        &[(4, "...X.X..."), (0, "....O...."), (1, "O........")],
        Some((0, 4)),
    );
    assert_eq!(before.position.turn, X);
    assert_eq!(before.playable, vec![4]);

    let after = mark(&before, 4, 4).unwrap();

    assert_eq!(after.boards[4], BoardState::Won { seat: X });
    assert_eq!(after.position.turn, O);
    assert_eq!(after.playable, vec![0, 1, 2, 3, 5, 6, 7, 8]);
}

#[test]
fn a_move_in_the_wrong_board_is_refused_and_says_where_to_play() {
    let after = play(&fresh(0), &[(0, 4)]);

    assert_eq!(
        reason(mark(&after, 3, 3)),
        "you must play in board 5, where the last mark sent you"
    );
    assert!(mark(&after, 4, 3).is_ok());
}

#[test]
fn with_two_boards_open_a_free_player_picks_either_and_cannot_pass() {
    // Example 10, with the open boards being 3 and 7 counted from 0 (4 and 8 in the doc). The
    // last mark was in cell 0, which names board 0, a won one.
    let state = position(
        &[
            (0, X_WON),
            (1, O_WON),
            (2, X_WON),
            (4, O_WON),
            (5, O_WON),
            (6, O_WON),
            (8, X_WON),
            (3, "X........"),
        ],
        Some((1, 0)),
    );

    assert_eq!(open(&state), vec![3, 7]);
    assert_eq!(state.playable, vec![3, 7]);
    assert!(mark(&state, 3, 1).is_ok());
    assert!(mark(&state, 7, 1).is_ok());
    // There is a move, and every move there is stays inside the two open boards.
    assert!(!legal(&state).is_empty());
    for board in 0..9 {
        for cell in 0..9 {
            let allowed = mark(&state, board, cell).is_ok();
            let empty = state.position.cells[board][cell].is_none();
            assert_eq!(allowed, state.playable.contains(&board) && empty);
        }
    }
}

// --- Refusals ---

#[test]
fn a_taken_cell_is_refused() {
    // X's mark in cell 4 of board 1, then O's in cell 1 of board 5, which sends X back to board 1.
    let state = play(&fresh(0), &[(0, 4), (4, 0)]);
    assert_eq!(state.playable, vec![0]);
    assert_eq!(reason(mark(&state, 0, 4)), "that cell is already taken");

    let state = play(&fresh(0), &[(0, 0)]);
    assert_eq!(reason(mark(&state, 0, 0)), "that cell is already taken");
}

#[test]
fn it_is_not_your_turn_unless_you_are_the_player_to_move() {
    let game = fresh(0);

    for seat in [1, 2] {
        let other = UltimateTicTacToe::apply(&game, seat, Action::Play { board: 4, cell: 4 });
        assert_eq!(reason(other), "not your turn");
    }
}

#[test]
fn a_cell_that_does_not_exist_is_refused() {
    assert_eq!(reason(mark(&fresh(0), 9, 0)), "there is no such cell");
    assert_eq!(reason(mark(&fresh(0), 0, 9)), "there is no such cell");
    assert_eq!(reason(mark(&fresh(0), 100, 100)), "there is no such cell");
}

#[test]
fn nothing_can_be_played_after_the_game() {
    let over = fresh(0).forfeit(1).unwrap();
    assert_eq!(reason(mark(&over, 4, 4)), "the game is over");

    let won = mark(&about_to_win(), 8, 8).unwrap();
    assert_eq!(reason(mark(&won, 1, 5)), "the game is over");
}

#[test]
fn actions_are_read_from_json_and_only_a_play_is_an_action() {
    let action: Action =
        serde_json::from_value(json!({ "type": "play", "board": 4, "cell": 2 })).expect("a play");
    assert_eq!(action, Action::Play { board: 4, cell: 2 });

    // Example 12: there is no taking a move back (D9), and no passing.
    for bad in [
        json!({ "type": "pass" }),
        json!({ "type": "undo" }),
        json!({ "type": "forfeit" }),
        json!({ "type": "play", "board": -1, "cell": 2 }),
        json!({ "type": "play", "board": 4 }),
        json!({ "board": 4, "cell": 2 }),
    ] {
        assert!(
            serde_json::from_value::<Action>(bad.clone()).is_err(),
            "{bad}"
        );
    }
}

#[test]
fn a_refused_move_leaves_the_game_as_it_was() {
    let game = play(&fresh(0), &[(0, 4)]);
    let before = serde_json::to_value(&game).unwrap();

    assert!(mark(&game, 3, 3).is_err());

    assert_eq!(serde_json::to_value(&game).unwrap(), before);
}

// --- Winning small boards and the game ---

#[test]
fn a_ninth_mark_that_completes_a_line_wins_the_board() {
    // Example 6: board 2 has eight marks and no line, and X marks the ninth and completes the
    // diagonal. O's last mark was in cell 1 of this board, which names it.
    let before = position(&[(1, "XOO OXX XO.")], Some((1, 1)));
    assert_eq!(before.boards[1], BoardState::Open);
    assert_eq!(before.playable, vec![1]);

    let after = mark(&before, 1, 8).unwrap();

    assert_eq!(after.boards[1], BoardState::Won { seat: X });
    assert_eq!(after.position.phase, Phase::Play);
    assert_eq!(after.line, None);
    // The ninth mark is in cell 8, which sends O to board 8.
    assert_eq!(after.playable, vec![8]);
}

#[test]
fn a_full_board_with_no_line_is_drawn_and_belongs_to_nobody() {
    // O's ninth mark in board 2 makes no line, and the board ends up full. X's last mark, in
    // cell 2 of board 1, sent O there.
    let before = position(&[(1, "XOX XOO OX."), (0, ".X.......")], Some((0, 1)));
    assert_eq!(before.position.turn, O);
    assert_eq!(before.boards[1], BoardState::Open);

    let after = mark(&before, 1, 8).unwrap();

    assert_eq!(after.boards[1], BoardState::Drawn);
    assert_eq!(after.position.phase, Phase::Play);
    assert_eq!(after.line, None);
    assert_eq!(after.playable, vec![8]);
}

#[test]
fn a_line_of_small_boards_wins_the_game_at_once() {
    // Example 8: X holds boards 1 and 5 and completes board 9, a diagonal of the big board.
    // The other boards are still open and are never played.
    let before = about_to_win();
    assert_eq!(before.position.turn, X);
    assert_eq!(before.playable, vec![8]);

    let after = mark(&before, 8, 8).unwrap();

    assert_eq!(over(&after), won_by(X));
    assert_eq!(after.line, Some([0, 4, 8]));
    // The winner is still the player the turn is on, and nothing can be played.
    assert_eq!(after.position.turn, X);
    assert_eq!(after.playable, Vec::<usize>::new());
    assert_eq!(
        after.position.last,
        Some(Last {
            seat: X,
            board: 8,
            cell: 8
        })
    );
    assert!(after.boards.contains(&BoardState::Open));
}

#[test]
fn every_line_of_three_boards_wins_the_game() {
    for [a, b, c] in LINES {
        // X holds boards `a` and `b` and needs cell 8 of board `c`. O's last mark was cell `c`
        // of board `a`, which sent X to board `c`. X's line in board `a` stays off that cell.
        let x_line = if c < 3 { [3, 4, 5] } else { [0, 1, 2] };
        let spare = (0..9)
            .find(|cell| !x_line.contains(cell) && *cell != c)
            .unwrap();
        let mut in_a = ['.'; 9];
        for cell in x_line {
            in_a[cell] = 'X';
        }
        in_a[c] = 'O';
        in_a[spare] = 'O';
        let in_a: String = in_a.iter().collect();
        let before = position(
            &[(a, in_a.as_str()), (b, X_WON), (c, X_NEEDS_EIGHT)],
            Some((a, c)),
        );
        assert_eq!(before.playable, vec![c], "line {a}-{b}-{c}");

        let after = mark(&before, c, 8).unwrap();

        assert_eq!(over(&after), won_by(X), "line {a}-{b}-{c}");
        assert_eq!(after.line, Some([a, b, c]));
    }
}

#[test]
fn the_other_player_can_win_the_game_too() {
    // Mirror of example 8: O to move holds boards 0 and 4 and completes board 8.
    let before = position(
        &[
            (0, "OOO X.. ..X"),
            (4, O_WON),
            (8, "OX. XOX .X."),
            (1, "X........"),
        ],
        Some((0, 8)),
    );
    assert_eq!(before.position.turn, O);
    assert_eq!(before.playable, vec![8]);

    let after = mark(&before, 8, 8).unwrap();

    assert_eq!(over(&after), won_by(O));
    assert_eq!(after.line, Some([0, 4, 8]));
}

#[test]
fn a_move_that_completes_two_lines_of_boards_reports_the_first_in_the_order_rows_columns_diagonals()
{
    // X holds boards 1, 2, 3 and 6, and wins board 0: both 0-1-2 and 0-3-6 are made.
    let before = position(
        &[
            (1, "O.. XXX O.."),
            (2, X_WON),
            (3, X_WON),
            (6, X_WON),
            (0, ".OO OXO OOX"),
        ],
        Some((1, 0)),
    );
    assert_eq!(before.playable, vec![0]);

    let after = mark(&before, 0, 0).unwrap();

    assert_eq!(over(&after), won_by(X));
    assert_eq!(after.line, Some([0, 1, 2]));
}

#[test]
fn drawn_boards_are_dead_for_both_players() {
    // Example 7: X holds boards 1 and 2 and board 3 is drawn, so the top row can't be made.
    let state = position(&[(0, X_WON), (1, X_WON), (2, DRAWN)], Some((0, 2)));

    assert_eq!(state.boards[2], BoardState::Drawn);
    assert_eq!(rules::won_line(&state.boards, X), None);
    assert_eq!(rules::won_line(&state.boards, O), None);
    assert_eq!(state.position.phase, Phase::Play);
    assert_eq!(state.line, None);
    // Three boards of the top row are closed, and it still is not a win for anybody.
    assert_eq!(state.playable, vec![3, 4, 5, 6, 7, 8]);
}

#[test]
fn a_drawn_board_does_not_count_for_the_player_who_made_the_last_mark() {
    // The same, but O is the one that has closed the board with the ninth mark.
    // X's last mark, in cell 3 of board 1, sent O to board 3 (the doc's numbers). O's ninth mark
    // there draws it.
    let before = position(
        &[(0, X_WON), (1, X_WON), (2, "XOX XOO OX."), (3, "O........")],
        Some((0, 2)),
    );
    assert_eq!(before.position.turn, O);
    assert_eq!(before.playable, vec![2]);

    let after = mark(&before, 2, 8).unwrap();

    assert_eq!(after.boards[2], BoardState::Drawn);
    assert_eq!(after.position.phase, Phase::Play);
}

#[test]
fn the_game_is_a_draw_when_every_board_is_closed_and_nobody_has_a_line() {
    // Example 9: every board but board 9 is closed. X marks its last cell, which draws it.
    // Boards (counted from 0): X holds 0, 2, 3, 7; O holds 1, 4, 5, 6; board 8 is drawn.
    let before = position(
        &[
            (0, X_WON),
            (2, X_WON),
            (3, X_WON),
            (7, X_WON),
            (4, O_WON),
            (5, O_WON),
            (6, O_WON),
            (1, "XXO ..O ..O"),
            (8, "XOX XOO OX."),
        ],
        Some((1, 8)),
    );
    assert_eq!(before.playable, vec![8]);
    assert_eq!(open(&before), vec![8]);

    let after = mark(&before, 8, 8).unwrap();

    assert_eq!(after.boards[8], BoardState::Drawn);
    assert_eq!(
        over(&after),
        Phase::Over {
            winner: None,
            forfeited: false
        }
    );
    assert_eq!(after.line, None);
    assert_eq!(after.playable, Vec::<usize>::new());
    // A move that ends the game doesn't pass the turn on.
    assert_eq!(after.position.turn, X);
}

// --- Forfeit (D10, example 11) ---

#[test]
fn a_forfeit_before_the_first_move_gives_the_other_player_the_win() {
    for x in [0, 1] {
        for seat in [0, 1] {
            let game = fresh(x);

            let after = game.forfeit(seat).unwrap();

            assert_eq!(over(&after), forfeited(1 - seat));
            assert_eq!(after.position.turn, x, "a forfeit doesn't change the turn");
            assert_eq!(after.position.last, None);
            assert_eq!(after.line, None);
            assert_eq!(after.playable, Vec::<usize>::new());
        }
    }
}

#[test]
fn either_player_can_forfeit_on_either_turn() {
    let game = play(&fresh(0), &[(0, 4)]);
    assert_eq!(game.position.turn, O);

    // O's turn: O gives up, or X does, which isn't X's turn.
    for seat in [O, X] {
        let after = UltimateTicTacToe::forfeit(&game, seat).unwrap();

        assert_eq!(over(&after), forfeited(1 - seat));
        assert_eq!(after.position.turn, O);
        assert_eq!(after.position.cells, game.position.cells);
        assert_eq!(after.position.last, game.position.last);
    }
}

#[test]
fn a_player_who_is_ahead_can_forfeit_and_loses_all_the_same() {
    // Example 11: X holds two boards of a line, and it is O's turn. O gives up, and X wins.
    // Had X given up, O would have won.
    let after_one_more = mark(&about_to_win(), 8, 2).unwrap();
    assert_eq!(after_one_more.position.turn, O);
    assert_eq!(after_one_more.boards[0], BoardState::Won { seat: X });
    assert_eq!(after_one_more.boards[4], BoardState::Won { seat: X });

    let o_gives_up = after_one_more.forfeit(O).unwrap();
    let x_gives_up = after_one_more.forfeit(X).unwrap();

    assert_eq!(over(&o_gives_up), forfeited(X));
    assert_eq!(over(&x_gives_up), forfeited(O));
}

#[test]
fn a_forfeit_has_no_line_and_its_json_says_who_gave_up() {
    let after = fresh(0).forfeit(1).unwrap();

    let value = serde_json::to_value(&after).unwrap();

    assert_eq!(
        value["phase"],
        json!({ "type": "over", "winner": 0, "forfeited": true })
    );
    assert_eq!(value["line"], json!(null));
}

#[test]
fn a_game_that_is_over_cannot_be_given_up() {
    let forfeited_game = fresh(0).forfeit(0).unwrap();
    let won = mark(&about_to_win(), 8, 8).unwrap();

    for game in [&forfeited_game, &won] {
        for seat in [0, 1] {
            assert_eq!(reason(game.forfeit(seat)), "the game is over");
        }
    }
}

#[test]
fn only_the_two_seats_can_forfeit() {
    assert_eq!(reason(fresh(0).forfeit(2)), "there is no such seat");
}

// --- Record and reading (the derived fields) ---

fn engine() -> std::sync::Arc<dyn crate::game::Engine> {
    Games::default()
        .with::<UltimateTicTacToe>()
        .get(UltimateTicTacToe::KIND)
        .unwrap()
        .clone()
}

#[test]
fn the_game_is_registered_with_its_constants() {
    let engine = engine();

    assert_eq!(engine.kind(), "ultimate-tic-tac-toe");
    assert_eq!(engine.players(), 2);
    assert_eq!(engine.state_version(), 1);
    assert!(engine.has_bot());
    assert!(
        crate::game::registry()
            .get("ultimate-tic-tac-toe")
            .is_some()
    );
}

#[test]
fn a_record_is_the_state_without_the_boards_the_player_may_play_in() {
    let game = play(&fresh(0), &[(0, 4), (4, 2)]);

    let record = UltimateTicTacToe::record(&game).unwrap();

    let mut expected = serde_json::to_value(&game).unwrap();
    expected.as_object_mut().unwrap().remove("playable");
    assert_eq!(record, expected);
    // What a past position looks like stays; what is worked out again when a state is read goes.
    assert!(record.get("playable").is_none());
    assert!(record.get("boards").is_some());
    assert!(record.get("line").is_some());
    assert_eq!(record["last"], json!({ "seat": 1, "board": 4, "cell": 2 }));
}

#[test]
fn a_record_keeps_the_winning_line() {
    let won = mark(&about_to_win(), 8, 8).unwrap();

    let record = UltimateTicTacToe::record(&won).unwrap();

    assert_eq!(record["line"], json!([0, 4, 8]));
    assert!(record.get("playable").is_none());
}

#[test]
fn the_history_view_puts_back_the_board_the_position_sent_the_player_to() {
    // The mark in cell 3 of board 5 sent the player to board 3.
    let game = play(&fresh(0), &[(0, 4), (4, 2)]);
    let record = UltimateTicTacToe::record(&game).unwrap();

    let view = UltimateTicTacToe::history_view(record).unwrap();

    assert_eq!(view["playable"], json!([2]));
    assert_eq!(view, serde_json::to_value(&game).unwrap());
}

#[test]
fn the_history_view_is_the_state_a_room_sends_for_every_kind_of_position() {
    let games = [
        // Anywhere, at the start.
        fresh(1),
        // Sent to a board that is decided: anywhere that is open.
        mark(&about_to_win(), 8, 8).unwrap(),
        play(&fresh(0), &[(0, 4), (4, 2), (2, 7)]),
        fresh(0).forfeit(1).unwrap(),
    ];
    for game in games {
        let record = UltimateTicTacToe::record(&game).unwrap();

        let view = engine().history_view(record).unwrap();

        assert_eq!(view, serde_json::to_value(&game).unwrap());
    }
}

#[test]
fn the_history_view_has_no_board_to_play_in_once_the_game_is_over() {
    let won = mark(&about_to_win(), 8, 8).unwrap();
    let forfeited = fresh(0).forfeit(1).unwrap();

    for game in [won, forfeited] {
        let record = UltimateTicTacToe::record(&game).unwrap();

        let view = UltimateTicTacToe::history_view(record).unwrap();

        assert_eq!(view["playable"], json!([]));
    }
}

#[test]
fn the_history_view_works_the_boards_out_again_and_does_not_trust_the_record() {
    let game = play(&fresh(0), &[(0, 4), (4, 2)]);
    let mut record = UltimateTicTacToe::record(&game).unwrap();
    record["playable"] = json!([7]);

    let view = UltimateTicTacToe::history_view(record).unwrap();

    assert_eq!(view["playable"], json!([2]));
}

#[test]
fn a_record_that_is_not_a_state_has_no_history_view() {
    assert!(UltimateTicTacToe::history_view(json!({ "x": 0 })).is_err());
    assert!(UltimateTicTacToe::history_view(json!(null)).is_err());
}

#[test]
fn a_record_loads_to_the_same_state() {
    let games = [
        fresh(1),
        play(&fresh(0), &[(0, 4), (4, 2), (2, 7)]),
        mark(&about_to_win(), 8, 8).unwrap(),
        fresh(0).forfeit(1).unwrap(),
    ];
    for game in games {
        let record = UltimateTicTacToe::record(&game).unwrap();

        let loaded = engine().load(1, record.clone()).expect("the record loads");

        assert_eq!(
            loaded.to_json(),
            serde_json::to_value(&game).map_err(|_| unreachable!())
        );
        assert_eq!(loaded.to_record().as_ref(), Ok(&record));
        assert_eq!(serde_json::from_value::<State>(record).unwrap(), game);
    }
}

#[test]
fn a_state_is_read_with_or_without_what_is_derived() {
    let game = play(&fresh(0), &[(0, 4), (4, 2)]);
    let full = serde_json::to_value(&game).unwrap();
    let mut bare = full.clone();
    for field in ["boards", "playable", "line"] {
        bare.as_object_mut().unwrap().remove(field);
    }

    assert_eq!(serde_json::from_value::<State>(full).unwrap(), game);
    assert_eq!(serde_json::from_value::<State>(bare).unwrap(), game);
}

#[test]
fn the_derived_fields_are_worked_out_again_and_never_trusted() {
    let game = play(&fresh(0), &[(0, 4), (4, 2)]);
    let mut value = serde_json::to_value(&game).unwrap();
    value["playable"] = json!([0, 1, 2]);
    value["boards"][0] = json!({ "type": "won", "seat": 1 });
    value["line"] = json!([0, 1, 2]);

    let read: State = serde_json::from_value(value).unwrap();

    assert_eq!(read, game);
    assert_eq!(read.playable, vec![2]);
    assert_eq!(read.boards[0], BoardState::Open);
    assert_eq!(read.line, None);
}

#[test]
fn a_finished_game_reads_back_with_its_line() {
    let won = mark(&about_to_win(), 8, 8).unwrap();

    let read = reread(&won);

    assert_eq!(read, won);
    assert_eq!(read.line, Some([0, 4, 8]));
}

// --- Validation of a position that is read ---

/// X at cell 4 of board 4 and O at cell 0 of board 4: two marks, X to move, sent to board 0.
fn two_marks() -> Position {
    let mut cells = [[None; 9]; 9];
    cells[4][4] = Some(X);
    cells[4][0] = Some(O);
    Position {
        x: X,
        cells,
        turn: X,
        last: Some(Last {
            seat: O,
            board: 4,
            cell: 0,
        }),
        phase: Phase::Play,
    }
}

fn refused(position: Position) -> String {
    State::try_from(position).expect_err("the position is refused")
}

#[test]
fn a_position_that_could_happen_is_accepted() {
    assert!(State::try_from(two_marks()).is_ok());
    assert!(State::try_from(Position::new(0)).is_ok());
    assert!(State::try_from(Position::new(1)).is_ok());
    // Seat 1 as X: seat 1 moves first, so it has the extra mark.
    let mut seat_one_first = two_marks();
    seat_one_first.x = O;
    seat_one_first.turn = O;
    seat_one_first.last = Some(Last {
        seat: X,
        board: 4,
        cell: 4,
    });
    assert!(State::try_from(seat_one_first).is_ok());
}

#[test]
fn marks_must_alternate_starting_with_x() {
    let mut too_many_x = two_marks();
    too_many_x.cells[0][0] = Some(X);
    too_many_x.cells[0][1] = Some(X);
    assert!(refused(too_many_x).contains("alternate"));

    let mut o_ahead = two_marks();
    o_ahead.cells[0][0] = Some(O);
    assert!(refused(o_ahead).contains("alternate"));
}

#[test]
fn the_turn_must_be_the_player_whose_move_it_is() {
    let mut wrong = two_marks();
    wrong.turn = O;

    assert_eq!(refused(wrong), "it is the other player's turn");
}

#[test]
fn a_seat_must_be_0_or_1() {
    let mut turn = two_marks();
    turn.turn = 2;
    let mut x = two_marks();
    x.x = 2;
    let mut mark = two_marks();
    mark.cells[1][1] = Some(2);

    for position in [turn, x, mark] {
        assert!(State::try_from(position).is_err());
    }
}

#[test]
fn the_last_mark_must_be_there_and_be_the_last_players() {
    let mut missing = two_marks();
    missing.last = None;
    assert!(refused(missing).contains("no last mark"));

    let mut none_played = Position::new(0);
    none_played.last = Some(Last {
        seat: O,
        board: 4,
        cell: 0,
    });
    assert!(refused(none_played).contains("no marks"));

    let mut empty_cell = two_marks();
    empty_cell.last = Some(Last {
        seat: O,
        board: 3,
        cell: 3,
    });
    assert!(refused(empty_cell).contains("last mark"));

    let mut wrong_seat = two_marks();
    wrong_seat.last = Some(Last {
        seat: X,
        board: 4,
        cell: 4,
    });
    assert!(refused(wrong_seat).contains("last mark"));

    let mut off_the_board = two_marks();
    off_the_board.last = Some(Last {
        seat: O,
        board: 9,
        cell: 0,
    });
    assert!(refused(off_the_board).contains("not on the board"));
}

#[test]
fn both_players_cannot_have_a_line_in_the_same_board() {
    let mut cells = [[None; 9]; 9];
    cells[0] = [
        Some(X),
        Some(X),
        Some(X),
        Some(O),
        Some(O),
        Some(O),
        None,
        None,
        None,
    ];
    let position = Position {
        x: X,
        cells,
        turn: X,
        last: Some(Last {
            seat: O,
            board: 0,
            cell: 5,
        }),
        phase: Phase::Play,
    };

    assert_eq!(
        refused(position),
        "both players have a line in one small board"
    );
}

#[test]
fn a_game_that_has_ended_cannot_still_be_played() {
    let won = mark(&about_to_win(), 8, 8).unwrap();
    let mut playing = won.position.clone();
    playing.phase = Phase::Play;

    assert!(refused(playing).contains("still being played"));
}

#[test]
fn the_result_must_match_the_boards() {
    let won = mark(&about_to_win(), 8, 8).unwrap();

    let mut wrong_winner = won.position.clone();
    wrong_winner.phase = won_by(O);
    assert_eq!(refused(wrong_winner), "the result doesn't match the boards");

    let mut draw = won.position.clone();
    draw.phase = Phase::Over {
        winner: None,
        forfeited: false,
    };
    assert_eq!(refused(draw), "the result doesn't match the boards");

    // Over, but nobody has won and a board is open.
    let mut early = two_marks();
    early.phase = won_by(X);
    assert_eq!(refused(early), "the result doesn't match the boards");

    let mut wrong_turn = won.position.clone();
    wrong_turn.turn = O;
    assert!(refused(wrong_turn).contains("turn"));
}

#[test]
fn a_forfeit_must_have_a_winner_and_leave_the_turn_alone() {
    let mut no_winner = two_marks();
    no_winner.phase = Phase::Over {
        winner: None,
        forfeited: true,
    };
    assert!(refused(no_winner).contains("forfeit"));

    let mut turned = two_marks();
    turned.phase = forfeited(O);
    turned.turn = O;
    assert!(refused(turned).contains("forfeit"));

    let mut a_third_seat = two_marks();
    a_third_seat.phase = forfeited(2);
    assert!(refused(a_third_seat).contains("forfeit"));

    // A game that had ended on the board can't have been given up.
    let won = mark(&about_to_win(), 8, 8).unwrap();
    let mut given_up = won.position.clone();
    given_up.phase = forfeited(O);
    assert!(refused(given_up).contains("had ended"));
}

#[test]
fn a_state_that_could_not_happen_fails_to_load() {
    let mut value = serde_json::to_value(play(&fresh(0), &[(0, 4)])).unwrap();
    value["turn"] = json!(0);

    assert!(serde_json::from_value::<State>(value.clone()).is_err());
    assert!(engine().load(1, value).is_err());
    // Nor does one of the wrong shape.
    assert!(engine().load(1, json!({ "x": 0 })).is_err());
}

// --- The bot ---

fn bot_move_at(state: &State, seat: usize, level: Level) -> Option<(usize, usize)> {
    UltimateTicTacToe::bot_action(state, seat, level)
        .map(|Action::Play { board, cell }| (board, cell))
}

/// What the medium bot plays: the bot that the rest of these tests are about, unless they say
/// another level.
fn bot_move(state: &State, seat: usize) -> Option<(usize, usize)> {
    bot_move_at(state, seat, Level::Medium)
}

#[test]
fn a_bot_of_every_level_has_nothing_to_play_out_of_turn_or_after_the_game() {
    for level in Level::ALL {
        let game = fresh(0);
        assert_eq!(bot_move_at(&game, 1, level), None);
        assert!(bot_move_at(&game, 0, level).is_some());

        assert_eq!(bot_move_at(&fresh(0).forfeit(1).unwrap(), 0, level), None);
        let won = mark(&about_to_win(), 8, 8).unwrap();
        for seat in [0, 1] {
            assert_eq!(bot_move_at(&won, seat, level), None);
        }
    }
}

#[test]
fn the_bot_wins_the_game_when_it_can() {
    // Only cell 8 of board 9 wins, and it is also a board win; both come first.
    for level in [Level::Medium, Level::Hard] {
        assert_eq!(
            bot_move_at(&about_to_win(), X, level),
            Some((8, 8)),
            "{level:?}"
        );
    }
}

#[test]
fn the_bot_wins_a_small_board_when_it_can() {
    let before = position(
        &[(4, "...X.X..."), (0, "....O...."), (1, "O........")],
        Some((0, 4)),
    );

    assert_eq!(bot_move(&before, X), Some((4, 4)));
}

#[test]
fn the_bot_blocks_a_line_the_opponent_would_make_with_that_cell() {
    // X is sent to board 4, where O holds cells 3 and 5 and X can't win: X takes cell 4.
    let before = position(&[(4, "X.. O.O .X."), (1, "X...O....")], Some((1, 4)));
    assert_eq!(before.position.turn, X);
    assert_eq!(before.playable, vec![4]);

    assert_eq!(bot_move(&before, X), Some((4, 4)));
}

#[test]
fn the_bot_does_not_send_the_opponent_where_they_can_win_a_board_if_it_can_help_it() {
    // X must play in board 4, which has two cells left, and neither wins, blocks or is
    // blocked. Cell 0 sends O to board 0, where O holds cells 3 and 4 and wins with cell 5.
    // Cell 1 sends O to the empty board 1.
    let before = position(
        &[(4, "..O OXX XOO"), (0, "...OO...."), (7, "X.X.X....")],
        Some((0, 4)),
    );
    assert_eq!(before.position.turn, X);
    assert_eq!(before.playable, vec![4]);
    assert_eq!(legal(&before), vec![(4, 0), (4, 1)]);

    // That is the medium bot's rule of thumb. The hard bot looks further than it and may play
    // otherwise for a reason, so this is not a test of it.
    for _ in 0..16 {
        assert_eq!(bot_move(&before, X), Some((4, 1)));
    }
}

#[test]
fn the_bot_picks_among_equal_moves_at_random() {
    // Most of the 81 cells rank the same on an empty board.
    let seen: std::collections::HashSet<_> =
        (0..200).filter_map(|_| bot_move(&fresh(0), X)).collect();

    assert!(seen.len() > 20, "{} different moves", seen.len());
}

#[test]
fn the_easy_bot_plays_any_move_the_rules_allow() {
    // On an empty board that is every cell, and where the player is sent it is the free cells
    // of that board.
    let seen: std::collections::HashSet<_> = (0..2000)
        .filter_map(|_| bot_move_at(&fresh(0), X, Level::Easy))
        .collect();
    assert_eq!(seen.len(), 81);

    // O has marked cell 4 of board 1, which sends X to board 4.
    let sent = position(&[(4, "X.. ... ..."), (1, "....O....")], Some((1, 4)));
    assert_eq!(sent.position.turn, X);
    assert_eq!(sent.playable, vec![4]);
    let moves: std::collections::HashSet<_> = (0..500)
        .filter_map(|_| bot_move_at(&sent, X, Level::Easy))
        .collect();
    assert_eq!(moves, legal(&sent).into_iter().collect());
}

#[test]
fn the_easy_bot_does_not_take_a_win_that_is_there_for_the_taking() {
    // Medium and hard always take the winning cell; easy takes it about as often as any other.
    let before = about_to_win();
    let legal_moves = legal(&before).len();
    assert!(legal_moves > 1);

    let taken = (0..400)
        .filter(|_| bot_move_at(&before, X, Level::Easy) == Some((8, 8)))
        .count();

    assert!(taken < 400, "easy took the win every time");
}

#[test]
fn the_hard_bot_does_not_hand_the_opponent_the_game() {
    // O has won boards 1 and 2, the first two of the top row, and board 3 is O's to win with
    // cell 3. X is sent to board 6, where cells 3 and 7 are empty and neither wins or blocks.
    //
    // - Cell 3 sends O to board 3, where O wins the board and so the game.
    // - Cell 7 sends O to board 7, where O can win a board too, but not the game. X is then sent
    //   to board 2, which O has won, and takes cell 3 of board 3 from there.
    //
    // The medium bot only asks whether O can win *a* board, which is so for both, so it can't
    // tell them apart. Seeing that one of them loses the game needs a look at O's answer.
    let before = position(
        &[
            (0, "OOO XX. ..."),
            (1, "OOO XX. ..."),
            (2, "OO. X.X ..."),
            (5, "XO. OXX .XO"),
            (6, "O.O .X. ..."),
            (8, "X.X ..X ..."),
            (4, ".....O..."),
        ],
        Some((4, 5)),
    );
    assert_eq!(before.position.turn, X);
    assert_eq!(before.playable, vec![5]);
    assert_eq!(legal(&before), vec![(5, 2), (5, 6)]);

    let medium: std::collections::HashSet<_> =
        (0..100).filter_map(|_| bot_move(&before, X)).collect();
    assert_eq!(medium.len(), 2, "medium plays either, as the comment says");

    for _ in 0..16 {
        assert_eq!(bot_move_at(&before, X, Level::Hard), Some((5, 6)));
    }
}

#[test]
fn the_hard_bot_plays_the_same_move_in_the_same_position_when_there_is_only_one_best() {
    // With a single best move there is nothing to pick between, so it can't waver.
    let before = about_to_win();
    let first = bot_move_at(&before, X, Level::Hard);
    for _ in 0..8 {
        assert_eq!(bot_move_at(&before, X, Level::Hard), first);
    }
}

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

impl crate::bot::Random for Rng {
    fn below(&mut self, n: usize) -> Option<usize> {
        (n > 0).then(|| Rng::below(self, n))
    }
}

/// How a player picks a move.
#[derive(Clone, Copy)]
enum Player {
    /// Any legal move, at random, without going through the bot.
    Random,
    Bot(Level),
}

/// Plays a game to its end, `players` being the two seats, checking the rules as it goes. A
/// game is at most 81 marks, since every one fills a cell.
fn play_out(x: usize, players: [Player; 2], rng: &mut Rng) -> State {
    let mut game = fresh(x);
    let mut marks = 0;
    while game.position.phase == Phase::Play {
        let moves = legal(&game);
        assert!(!moves.is_empty(), "a game that is on always has a move");
        let seat = game.position.turn;
        let (board, cell) = match players[seat] {
            Player::Random => moves[Rng::below(rng, moves.len())],
            Player::Bot(level) => match bot::action(&game, seat, level, rng) {
                Some(Action::Play { board, cell }) => (board, cell),
                None => panic!("the bot has a move"),
            },
        };
        assert!(
            moves.contains(&(board, cell)),
            "({board}, {cell}) is not legal"
        );
        game = mark(&game, board, cell).expect("a legal move is accepted");
        assert_eq!(reread(&game), game, "a state reads back as it was");
        marks += 1;
        assert!(marks <= 81, "the game does not end");
    }
    game
}

#[test]
fn random_games_always_end_and_never_break_the_rules() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut outcomes = [0; 3];
    for game in 0..300 {
        let end = play_out(game % 2, [Player::Random; 2], &mut rng);
        match over(&end) {
            Phase::Over {
                winner: Some(seat),
                forfeited: false,
            } => {
                assert!(end.line.is_some());
                outcomes[seat] += 1;
            }
            Phase::Over {
                winner: None,
                forfeited: false,
            } => {
                assert_eq!(end.line, None);
                outcomes[2] += 1;
            }
            other => panic!("{other:?}"),
        }
    }

    // Both seats win, and the first move is no guarantee.
    assert!(outcomes[0] > 30 && outcomes[1] > 30, "{outcomes:?}");
}

#[test]
fn a_bot_of_every_level_plays_only_legal_moves_against_a_random_player_on_either_side() {
    let mut rng = Rng(0x1234_5678_9abc_def1);
    for level in Level::ALL {
        for game in 0..40 {
            // The bot takes seat 0 and seat 1 in turn, and either seat may be X.
            let bot = game % 2;
            let mut players = [Player::Random; 2];
            players[bot] = Player::Bot(level);

            let end = play_out((game / 2) % 2, players, &mut rng);

            assert!(UltimateTicTacToe::is_over(&end), "{level:?}");
        }
    }
}

#[test]
fn bots_of_every_pair_of_levels_play_a_game_to_the_end() {
    let mut rng = Rng(7);
    for a in Level::ALL {
        for b in Level::ALL {
            for game in 0..6 {
                let end = play_out(game % 2, [Player::Bot(a), Player::Bot(b)], &mut rng);

                assert!(UltimateTicTacToe::is_over(&end), "{a:?} against {b:?}");
            }
        }
    }
}

/// How `a` does against `b` in `games` games, as [a's wins, b's wins, draws]. The two take
/// both seats and both marks in turn, so that nobody has the first move more than the other.
fn tournament(a: Level, b: Level, games: usize, seed: u64) -> [usize; 3] {
    let mut rng = Rng(seed | 1);
    let mut score = [0; 3];
    for game in 0..games {
        let a_seat = game % 2;
        let x = (game / 2) % 2;
        let mut players = [Player::Bot(b); 2];
        players[a_seat] = Player::Bot(a);
        match over(&play_out(x, players, &mut rng)) {
            Phase::Over {
                winner: Some(seat), ..
            } if seat == a_seat => score[0] += 1,
            Phase::Over {
                winner: Some(_), ..
            } => score[1] += 1,
            _ => score[2] += 1,
        }
    }
    score
}

#[test]
fn the_medium_bot_beats_the_easy_bot_nine_games_in_ten() {
    let [medium, easy, drawn] = tournament(Level::Medium, Level::Easy, 100, 11);

    // The games are repeatable, so this never wavers: it is here to notice a change that makes
    // the bot play worse, not to rate it.
    assert!(
        medium >= 85,
        "medium won {medium}, easy {easy}, drawn {drawn}"
    );
}

#[test]
fn the_hard_bot_beats_the_medium_bot_nine_games_in_ten() {
    let [hard, medium, drawn] = tournament(Level::Hard, Level::Medium, 40, 12);

    assert!(
        hard >= 34,
        "hard won {hard}, medium {medium}, drawn {drawn}"
    );
}

/// Prints how every level does against every other. Run it when changing a bot, in release mode
/// because the hard bot is slow without it:
/// `cargo test --release tournament_report -- --ignored --nocapture`
#[test]
#[ignore = "a measurement, not a check"]
fn tournament_report() {
    let games: usize = std::env::var("GAMES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(400);
    for (a, b) in [
        (Level::Medium, Level::Easy),
        (Level::Hard, Level::Medium),
        (Level::Hard, Level::Easy),
    ] {
        let [won, lost, drawn] = tournament(a, b, games, 2024);
        println!(
            "{a:?} against {b:?}: won {won}, lost {lost}, drawn {drawn} of {games} ({:.1}% won)",
            100.0 * won as f64 / games as f64
        );
    }
}
