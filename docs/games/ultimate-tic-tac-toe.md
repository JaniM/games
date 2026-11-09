# Ultimate tic-tac-toe: rules spec

This is the source of truth for the rules of ultimate tic-tac-toe on this site (also called super tic-tac-toe, meta tic-tac-toe or tic-tac-toe squared). Any rules engine, move validator, UI hint or test must follow it.

- **Do not silently deviate.** If the code needs a rule this file doesn't cover, or the file looks wrong, stop and ask the user. Then update this file in the same change.
- **Rules only.** UI, live versus asynchronous play, clocks, accounts and matchmaking are not covered here.
- **Open choices** are in [Decisions](#decisions). The source is silent on some points and the variants disagree on others, and each entry says what we chose.
- Last checked against sources: 2026-11-09 (see [Sources](#sources)).

## Overview

Two players, X and O, take turns marking cells. The board is a 3×3 grid of **small boards**, each a 3×3 grid of cells, so 81 cells in all. Winning a small board by ordinary tic-tac-toe rules claims it on the **big board**. The first player to claim three small boards in a line wins the game.

What makes it work is the **sending rule**: the cell a player marks inside a small board decides which small board the opponent must play in next. There is no hitting, no removing and no moving of marks. There are no dice and no hidden information.

## Coordinates

Small boards and cells are numbered 1–9 in reading order, left to right and top to bottom:

```
1 2 3
4 5 6
7 8 9
```

- `board b` is the small board at position `b` of the big board. `cell c of board b` is the cell at position `c` inside it. The same numbering is used at both levels, and that is what makes the sending rule simple: **a mark in cell `c` sends the opponent to board `c`**.
- This file numbers from 1. The code (the engine and what it sends) counts from 0, so board `b` and cell `c` are the indexes `b − 1` and `c − 1`.
- The eight **lines**, at both levels, are the rows `1-2-3`, `4-5-6`, `7-8-9`, the columns `1-4-7`, `2-5-8`, `3-6-9` and the diagonals `1-5-9`, `3-5-7`.
- A small board's **state** is one of:
  - **open**: not won and with at least one empty cell. Moves can be played in it.
  - **won by X** or **won by O**: closed.
  - **drawn**: all 9 cells marked and no line of one player's marks. Closed.
- "Closed" means won or drawn. A closed board takes no more moves, and its empty cells (if any) stay empty for the rest of the game.

X is the player who makes the first move of the game, and O is the other.

## Setup and starting player

- All 81 cells start empty, and all 9 small boards start open.
- X moves first and may play in any cell of any small board.
- Which player is X is decided at random. (See [D1](#decisions).)

## A turn

A turn is one move. The player to move marks one empty cell with their own symbol, in a small board the sending rule allows. A player may not pass, and a mark is never moved or removed once placed. A move is final: it cannot be taken back. (See [D9](#decisions).) Giving up is not a pass and is allowed. (See [D10](#decisions).)

There is always a legal move while the game is on. A game that isn't over has at least one open board, because the game ends the moment none is left, and an open board has an empty cell by definition.

## Legal move

A move is legal only if all of these hold:

1. **Empty cell.** The cell is not already marked.
2. **Open board.** The small board holds the cell is open (not won, not drawn).
3. **Sending rule.** Let `c` be the cell the opponent marked on the previous move.
   - If board `c` is open, the move must be in board `c`. This includes the case where `c` is the board the opponent just played in, so a player can send the opponent back to the same board.
   - If board `c` is closed, the move may be in **any open board**. (See [D3](#decisions).)
   - On the first move of the game there is no previous move, and the move may be in any board.

The sending rule looks at the board **after** the previous move was resolved. If that move won or filled board `c` itself (a mark in cell `c` of board `c`), board `c` is now closed, and the next player chooses freely.

## After a move

Resolve these in order, stopping at the first that ends the game:

1. **Small board.** If the mover's marks in that small board now include a line, the board is **won by the mover**. This is checked before fullness, so a ninth mark that completes a line wins the board. (See [D6](#decisions).) Otherwise, if all 9 cells are marked, the board is **drawn**.
2. **Big board.** If the small boards won by the mover now include a line of the big board, **the mover wins the game** at once, whatever the state of the other boards. (See [D4](#decisions).)
3. **No open boards.** If no small board is open, the game is a **draw**. (See [D7](#decisions).)
4. Otherwise the opponent moves next.

A drawn board belongs to nobody. It counts for neither player in a big-board line, so any line through a drawn board can never be completed. (See [D5](#decisions).)

## End of the game

- The player who first claims three small boards in a line wins.
- If every small board is closed and nobody has a line on the big board, the game is a draw.
- **Forfeit (site rule).** A player may give up at any time in a game that is not over, on either turn, even before the first move. The other player wins, and the game ends at once. A player who deletes their account forfeits all their games against another person that are not over in the same way. (See [D10](#decisions).)
- Only a win, a loss or a draw is recorded. There is no margin of victory and no count of boards or cells, so a forfeit is a win like any other. (See [D7](#decisions).)

## Decisions

Points where the source is silent or the variants disagree. The entry in the Choice column is what the code must do until the user says otherwise.

| ID | Question | Choice | Notes |
|---|---|---|---|
| D1 | Who moves first, and who is X? | **X moves first. Which player is X is random.** | The source says the game starts with "either X or O" playing anywhere and doesn't say who. X first is the usual convention. Any other way of picking the starter (a roll, alternating between games, the challenger's choice) is a UI or matchmaking matter, as long as "X starts" always holds. |
| D2 | Where may the first move go? | **Anywhere: any cell of any board.** | The source says so. A first move in the centre of the centre board is not special. |
| D3 | What if the player is sent to a closed board? | **They may play in any open board.** | The source says so for both won and full boards. It is a free choice of board, not a free choice of cell inside a closed board. |
| D4 | What wins the game? | **Three small boards won by the same player in a line of the big board** (any of the eight lines). | The summary of the source page doesn't state this. It is the standard rule, and the page's description of the Tic-Tac-Ku variant ("at least five small boards, instead of three in a line") implies it. Not checked against a second source. |
| D5 | How does a drawn small board count on the big board? | **For nobody.** It is neither X's nor O's, and it never helps either player complete a line. | The source doesn't say how a drawn board is marked. Some play counts it for both players. That makes draws much rarer and favours whoever is nearer a line, so we don't use it. This is the rule to change if the user wants it. |
| D6 | A ninth mark that fills a small board and also completes a line? | **The board is won, not drawn.** | Not stated by the source. It is plain tic-tac-toe, where a win takes precedence over a full board. |
| D7 | How is a game with no winner decided? | **When no small board is open and nobody has a big-board line, it is a draw.** There is no tiebreak. | The source says so and gives no tiebreak. Some variants give the win to whoever claimed more small boards. We don't. |
| D8 | May players keep marking cells in a closed board? | **No.** A won or drawn board takes no more moves. | The source says so. The source also describes a variant where players must keep playing in decided boards while they have empty cells, and says a 2020 analysis showed a win for the first player under perfect play there. That is a different game and is not used. |
| D9 | May a player take back a move? | **No.** A move is final once played. | Not a rule of the sources: a site decision the user made on 2026-11-09. A turn is a single move, so there is no partial turn to undo either. The sending rule, the board states and the big board only ever move forward. |
| D10 | May a player give up, and what does it do? | **Yes, at any time in a game that is not over, on either turn, even before the first move. The other player wins.** The game ends at once, with no further move. **A player who deletes their account forfeits every game of theirs against another person that is not over, whether or not it has started.** Games against the computer opponent are not forfeited. | Not a rule of the sources: a site feature the user asked for on 2026-11-09, and the account deletion rule the user added the same day. A game with no move yet can be given up like any other. A forfeit is not a move, so the sending rule does not apply to it, and it cannot be taken back ([D9](#decisions)). It loses in every position, including one where the player giving up is ahead. Only a win, a loss or a draw is recorded ([D7](#decisions)), so the winner gets the same result as for a win on the board. The account deletion forfeit is the same forfeit, made for the player by the site, in each of their games on either turn. It applies whatever the position, including a game with no move yet. It is limited to games against another person: games against the computer opponent are deleted with the account, so there is nothing to forfeit, and a game still waiting for an opponent has nobody to win it. |

## Worked examples

All use the board and cell numbers above. "Board 5, cell 3" is cell 3 of small board 5.

1. **First move.** X plays board 1, cell 5. The cell is 5, so O must play in board 5, the centre board. Whatever cell O marks there sends X on.
2. **Sent back to the same board.** O is in board 5 and marks cell 5. The cell is 5, so X must play in board 5 again, if it is open.
3. **Sent to a won board.** Board 3 is won by X. O marks board 7, cell 3. X is sent to board 3, which is closed, so X may play in any open board.
4. **Sent to a drawn board.** Board 6 is full with no line. A player marks cell 6 of some board and sends the opponent to board 6. The opponent may play in any open board.
5. **A move that closes its own target.** Board 5 is open, and X marks cell 5 of board 5 and completes a line there. X now owns board 5, and the move sent O to board 5, which is closed. O may play in any open board.
6. **Win on the last cell.** Board 2 has eight marks and no line. X marks the ninth cell and completes a line. Board 2 is **won by X**, not drawn.
7. **Drawn boards are dead for both.** X owns boards 1 and 2, and board 3 is drawn. The line 1-2-3 can't be completed by X, or by anyone else. Boards 1 and 2 are still useful to X in the lines 1-4-7 and 2-5-8.
8. **Winning the game.** X owns boards 1 and 5, and X's move in board 9 completes a line there. Boards 1, 5 and 9 are a big-board diagonal, so X wins at once. Every other board may still have empty cells, and they are never played.
9. **Draw.** Every small board is won or drawn, and neither player owns three in a line. The game is a draw.
10. **No pass.** Every board that the sending rule points to is closed, and boards 4 and 8 are the only open ones. The player to move may play in either. They can't pass, and they can't play in a closed board.
11. **Forfeit.** It is O's turn and X owns boards 1 and 5, one short of a line. O gives up. The game is over at once, and X wins. Had X, who is ahead, given up instead, O would have won in the same way.
13. **Account deletion.** X deletes their account while four of their games are going: it is X's turn in one, the opponent's turn in another, the third has no first move yet, and the fourth is against the computer opponent. The first three end at once with a win for the opponent, the third included. The fourth is deleted with the account and is not forfeited.
12. **No takeback.** X marks board 4, cell 7 by mistake, and O has not moved yet. The mark stays, and O is sent to board 7. X cannot take it back, but X can still give up.

## Out of scope

Live versus asynchronous play, clocks and time limits, match play and swapping X and O between games, ratings, spectators, UI orientation and animations, how the computer opponent chooses its moves (it plays only moves the rules above allow, so it needs no rules of its own), and any balancing of the first-move advantage (a pie rule, a random opening). Forfeit is allowed, including the one made by account deletion ([D10](#decisions)), and undo is not ([D9](#decisions)).

## Sources

The page was read through a summarising fetch tool, not word for word. Where this file says "not checked", the claim comes from the common form of the game and not from the page.

- English Wikipedia, [Ultimate tic-tac-toe](https://en.wikipedia.org/wiki/Ultimate_tic-tac-toe): the 3×3 grid of small boards, the first move anywhere, the sending rule, closed boards taking no more moves, a free choice of board when sent to a closed one, a small board claimed on the big board when won, and a draw when no playable board is left. Also the variants named in D5, D7 and D8 (mandatory play in decided boards, Tic-Tac-Ku, and the others).
- Not in that summary, so **not checked**: the big-board win condition (D4), the handling of drawn small boards on the big board (D5), and the precedence of a win over a full board (D6).
