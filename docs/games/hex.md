# Hex: rules spec

This is the source of truth for the rules of Hex on this site. Any rules engine, move validator, UI hint or test must follow it.

- **Do not silently deviate.** If the code needs a rule this file doesn't cover, or the file looks wrong, stop and ask the user. Then update this file in the same change.
- **Rules only.** UI, live versus asynchronous play, clocks, accounts and matchmaking are not covered here.
- **Open choices** are in [Decisions](#decisions). The sources are silent on some points and offer more than one form of others, and each entry says what we chose.
- Last checked against sources: 2026-11-10 (see [Sources](#sources)).

## Overview

Two players, Red and Blue, take turns placing one stone of their colour on an empty cell of a rhombus-shaped board of hexagons. Each player owns two opposite edges of the board. The first player to link their two edges with an unbroken chain of their own stones wins.

Stones are never moved, captured or removed. There are no dice and no hidden information. **A draw is impossible**: a full board always has exactly one player's edges connected. To offset the first player's advantage, the **swap rule** lets Blue, on Blue's first turn, take over Red's opening stone instead of placing one.

## Coordinates

The board is 11 × 11 cells, 121 in all. (See [D1](#decisions).)

- **Columns** are lettered `a`–`k` and **rows** are numbered `1`–`11`. A cell is named by column, then row: `a1`, `f6`, `k11`. No letter is skipped, so `i` is a column.
- When this file needs arithmetic, `(c, r)` is the cell in column number `c` (`a` = 1 … `k` = 11) and row `r`. Code that counts from 0 uses `c − 1` and `r − 1`.
- `a1` is an **acute corner**. Drawn the usual way, `a1` is at the top left, row 1 runs along the top edge, column `a` runs down the left edge, and each row sits half a cell to the right of the row above it:

  ```
  a1  b1  c1  d1  …  k1
    a2  b2  c2  d2  …  k2
      a3  b3  c3  d3  …  k3
        …
  ```

- **Neighbours.** Cell `(c, r)` touches up to six cells: `(c − 1, r)` and `(c + 1, r)` in its own row, `(c, r − 1)` and `(c + 1, r − 1)` in the row above, and `(c − 1, r + 1)` and `(c, r + 1)` in the row below. Any of these that fall off the board don't exist. Around `f6`:

  ```
    f5  g5
  e6  f6  g6
    e7  f7
  ```

  `(c − 1, r − 1)` and `(c + 1, r + 1)` are **not** neighbours: `e5` and `g7` do not touch `f6`.
- **Edges.** Red owns the **top** edge (row 1) and the **bottom** edge (row 11). Blue owns the **left** edge (column `a`) and the **right** edge (column `k`). A cell is on an edge if it is in that row or column.
- **Corners.** `a1` and `k11` are the acute corners, with 2 neighbours each. `k1` and `a11` are the obtuse corners, with 3. Each corner cell is on two edges, one of each player's, and counts as being on both. (See [D6](#decisions).) Other edge cells have 4 neighbours, and inner cells have 6.
- **Long diagonal and mirror.** The long diagonal runs between the acute corners: `a1`, `b2`, … `k11`, the cells where `c = r`. Mirroring across it exchanges column and row, `(c, r) → (r, c)`: `a3` ↔ `c1`, `d5` ↔ `e4`. The mirror keeps neighbours as neighbours and maps Red's edges onto Blue's. Cells on the long diagonal mirror to themselves. The swap uses it. (See [D4](#decisions).)

Red is the player who makes the first move of the game, and Blue is the other. A player's colour, and so their edges, never change during a game.

## Setup and starting player

- All 121 cells start empty.
- Red moves first and may place the first stone on any cell. (See [D5](#decisions).)
- Which player is Red is decided at random. (See [D2](#decisions).)

## A turn

A turn is one move. The player to move does one of:

- **Place:** put one stone of their own colour on any empty cell.
- **Swap:** only on Blue's first turn, as described below.

A player may not pass. (See [D7](#decisions).) A stone is never moved or removed once placed, except by the swap. A move is final: it cannot be taken back. (See [D8](#decisions).) Giving up is not a pass and is allowed. (See [D9](#decisions).)

## Legal move

- **Place** is legal on any empty cell, on any turn of either player. Nothing else restricts it: there is no forbidden cell and no rule about where the previous stone went.
- **Swap** is legal only on **Blue's first turn**: the second turn of the game, when the board holds Red's first stone and nothing else. Blue may swap or place, as Blue likes. Placing gives up the swap for good: Blue cannot swap on a later turn, and Red can never swap. (See [D3](#decisions).)

What the swap does (see [D4](#decisions)):

1. Red's stone at `(c, r)` is removed.
2. A Blue stone is placed at the mirror cell `(r, c)`. If Red's stone was on the long diagonal, this is the same cell, and the stone simply changes colour.
3. It is Red's turn. The players keep their colours and their edges.

After a swap the board holds one Blue stone and no Red stone, and Red is to move. From then on the turns simply alternate.

## After a move

1. **Connection.** Two stones of the same colour are **connected** if a sequence of stones of that colour leads from one to the other, each a neighbour of the next. A **chain** is a largest set of stones that are all connected to each other. A player has **connected their edges** when one of their chains has a stone on each of their two edges. If the mover has now connected their edges, **the mover wins** at once, whatever the rest of the board holds.
2. Otherwise the opponent moves next.

Only the mover needs checking. A placement only adds a stone of the mover's colour, and a swap only removes a Red stone and adds a Blue one, so neither can complete a chain for the player who did not move. A swap never wins: one stone can't be on both of a player's edges on an 11 × 11 board.

## End of the game

- The first player to connect their two edges wins.
- **There are no draws.** When every cell is filled, exactly one player has connected their edges (the "hex theorem"). So the game is always over by the time the board is full, at most 121 stones are ever on the board, and while the game is on there is always an empty cell to play.
- **Forfeit (site rule).** A player may give up at any time in a game that is not over, on either turn, even before the first move. The other player wins, and the game ends at once. A player who deletes their account forfeits all their games against another person that are not over in the same way. (See [D9](#decisions).)
- Only a win or a loss is recorded. There is no margin of victory and no count of stones, so a forfeit is a win like any other.

## Decisions

Points where the sources are silent or offer a choice. The entry in the Choice column is what the code must do until the user says otherwise.

| ID | Question | Choice | Notes |
|---|---|---|---|
| D1 | What size is the board? | **11 × 11, the only size offered.** | English Wikipedia: "traditionally played on an 11×11 rhombus board, although 13×13 and 19×19 boards are also popular". HexWiki names the same three as the most common. Every rule above is written for an `n × n` board with `n` = 11, so other sizes only change the last letter and number, the cell count and the 121-stone bound. The user chose 11 × 11 only on 2026-11-10. This is the entry to change if the user wants a choice of sizes. |
| D2 | Who moves first, which colour is which, and who owns which edges? | **Red moves first and owns top and bottom. Blue owns left and right. Which player is Red is random.** | HexWiki: the first player's colour is red, and with `a1` at the top left "the top and bottom edges are red and the left and right edges are blue". English Wikipedia says the colours are conventionally red and blue (or black and white) and that "the most common convention is for Red or Black to go first". Any other way of picking the starter (alternating between games, the challenger's choice) is a UI or matchmaking matter, as long as "Red starts" always holds. |
| D3 | Is the swap rule used? | **Yes.** On Blue's first turn only, Blue may swap instead of placing a stone. It is optional, and there is at most one swap per game. | English Wikipedia: "the swap rule (also called the pie rule) is normally used" to offset the first player's advantage, and "allows the second player to choose whether to switch positions with the first player after the first player makes the first move". Without it the first player has a winning strategy on every board size (Wikipedia, by strategy stealing). With it, Red is pushed to open with a stone that is neither too strong nor too weak. HexWiki mentions a multi-stone swap proposal that is "not widely used, nor implemented by any game sites". It is not used. |
| D4 | What does a swap do? | **"Swap pieces": Red's stone is replaced by a Blue stone on the mirror cell across the long diagonal, and Red moves next. Nobody changes colour.** | HexWiki describes two forms. In **swap sides** the players exchange colours, the stone stays where it is, and the new Blue (who made the first move) moves next. In **swap pieces** the colours stay, the stone is mirrored and recoloured, and Red moves next. HexWiki says swap sides is "most practical" face to face and swap pieces "is more common" online, "presumably because the colours are determined at the start of the game". The two give the same game: the position after one is the position after the other, mirrored and with the colours exchanged, with the same player to move. We use swap pieces so that a player's colour and edges never change during a game. The user approved this form on 2026-11-10. The formula `(c, r) → (r, c)` is not stated by HexWiki: it follows from its example ("a red piece at a3 becomes a blue piece at c1") and from the mirror being across the long diagonal. |
| D5 | Is Red's first stone restricted? | **No. Red may open on any cell, the centre included.** | Neither source restricts it. HexWiki says moves near the centre "are far too strong and should be swapped", which is a matter of strategy: the swap rule is what keeps them in check. |
| D6 | Whose edge is a corner cell on? | **Both players'.** `a1` is on Red's top edge and on Blue's left edge, and the same for the other three corners. | English Wikipedia: "The hexagons on each of the four corners belong to both adjacent board edges." With the edges defined by row and column, this needs no special case. |
| D7 | May a player pass? | **No.** | Neither source mentions passing, and the game as described has none. A pass would never help anyway: an extra stone of a player's own colour never hurts them (a known property of Hex, not from the sources read). Because there are no draws, an empty cell always exists while the game is on, so there is always a legal move. |
| D8 | May a player take back a move? | **No.** A move is final once played. | Not a rule of the sources: a site decision the user confirmed for Hex on 2026-11-10. It matches ultimate tic-tac-toe (its D9), since a Hex turn is also a single move with nothing partial to undo. A swap is a move like any other and cannot be undone either. |
| D9 | May a player give up, and what does it do? | **Yes, at any time in a game that is not over, on either turn, even before the first move. The other player wins.** The game ends at once, with no further move. **A player who deletes their account forfeits every game of theirs against another person that is not over, whether or not it has started.** Games against the computer opponent are not forfeited. | English Wikipedia: "it is customary, but not required, for the losing player to resign. In practice, most games of Hex end with one of the players resigning." The details follow the site rule the user set for ultimate tic-tac-toe on 2026-11-09 (its D10), including the account deletion forfeit, and the user confirmed them for Hex on 2026-11-10. A forfeit is not a move, so it is not a pass, does not use up Blue's swap, and cannot be taken back ([D8](#decisions)). It loses in every position, including one where the player giving up is ahead. Games against the computer opponent are deleted with the account, so there is nothing to forfeit, and a game still waiting for an opponent has nobody to win it. |

## Worked examples

All use the cell names above on the 11 × 11 board.

1. **Neighbours.** `f6` touches `e6`, `g6`, `f5`, `g5`, `e7` and `f7`. It does not touch `e5` or `g7`. The corner `a1` touches only `b1` and `a2`. The corner `k1` touches `j1`, `j2` and `k2`.
2. **Not connected.** Red has stones on `e5` and `f6` only. They do not touch, so they are two chains. They become one chain if Red later places a stone on `f5` or on `e6`, the two cells both of them touch.
3. **Swap, off the diagonal.** Red opens on `d5`. Blue swaps: `d5` is emptied and a Blue stone goes on `e4`. It is Red's turn, and Red has no stone on the board.
4. **Swap, on the diagonal.** Red opens on `f6`, the centre. Blue swaps: the stone on `f6` becomes Blue. It is Red's turn.
5. **Swap from HexWiki.** Red opens on `a3`, on Blue's left edge. Blue swaps: the Blue stone goes on `c1`, on Red's top edge.
6. **No swap.** Red opens on `a1`. Blue places a stone on `f6` instead of swapping. The swap is gone for good. On Blue's next turn, and for the rest of the game, Blue can only place.
7. **Winning.** Red has stones on `f1` to `f10`, and `f11` is empty. Red places on `f11`. The chain `f1`–`f11` has stones on row 1 and row 11, so Red wins at once, however many cells are still empty.
8. **On the opponent's edge.** Red's chain is `a1`, `a2`, … `a11`, all along Blue's left edge. It has stones on row 1 and row 11, so it connects Red's edges, and Red wins. Lying on Blue's edge does not matter.
9. **Corners count for both.** Blue's chain is `a1`, `b1`, … `k1`, the whole top row. `a1` is on column `a` and `k1` is on column `k`, so Blue has connected Blue's edges and wins, even though every stone is on Red's top edge.
10. **Wrong pair of edges.** Red's chain runs from `a6` to `k6`, the middle row. It touches the left and right edges, which are Blue's, and neither of Red's. It does not win.
11. **No draw.** The board can never be full with no winner, so the 121st stone, if the game gets that far, is always the winning one, and the game never runs out of moves.
12. **Forfeit.** It is Blue's turn, and Red has a chain from row 1 down to row 10 with two open ways to row 11. Red gives up. The game is over at once, and Blue wins.
13. **Forfeit on the second turn.** Red opens on `f6`. Before choosing whether to swap, Blue gives up. Red wins. The swap does not have to be used or declined first.
14. **No takeback.** Blue swaps by mistake, meaning to place a stone. The swap stands, and it is Red's turn. Blue cannot take it back, but Blue can still give up.
15. **Account deletion.** Red deletes their account while three of their games are going: one against a person where it is Blue's turn, one against a person with no first move yet, and one against the computer opponent. The first two end at once with a win for the opponent. The third is deleted with the account and is not forfeited.

## Out of scope

Board sizes other than 11 × 11 ([D1](#decisions)), live versus asynchronous play, clocks and time limits, match play and swapping colours between games, ratings, spectators, how the board is drawn on screen (which corner is where, rotation, animations), how moves and the swap are written in a game record, and how the computer opponent chooses its moves (it plays only moves the rules above allow, including choosing whether to swap, so it needs no rules of its own). Forfeit is allowed, including the one made by account deletion ([D9](#decisions)), and undo is not ([D8](#decisions)).

## Sources

The pages were read through a fetch tool that summarises and quotes, not word for word. Quotes above are from what it returned. Where this file says "not stated" or "follows from", the point is derived from the pages and not written in them.

- English Wikipedia, [Hex (board game)](https://en.wikipedia.org/wiki/Hex_(board_game)): the rhombus of hexagons, 11 × 11 as the traditional size with 13 × 13 and 19 × 19 also popular, red and blue (or black and white), two opposite edges per player, alternate placement on a single cell, stones never moved or removed, the win by connecting one's two edges, no draws (the hex theorem), the swap rule normally used, corners belonging to both edges, Red or Black first as the common convention, resignation as custom, and the first player's winning strategy without the swap.
- HexWiki, [Swap rule](https://www.hexwiki.net/index.php/Swap_rule): Blue decides after Red's first move, the two forms "swap sides" and "swap pieces" and who moves next in each, the mirror across the long diagonal with the example `a3` → `c1`, swap pieces being more common online, centre openings being "far too strong", and the unused multi-stone proposal.
- HexWiki, [Rules](https://www.hexwiki.net/index.php/Rules): red for the first player, and the common board sizes.
- HexWiki, [Board](https://www.hexwiki.net/index.php/Board): files lettered and ranks numbered, `a1` always an acute corner, `a1` usually drawn at 10 o'clock with red on top and bottom and blue on left and right, and the acute and obtuse corners.
- Derived, **not stated** by the pages: the half-cell shift to the right on each row, the six neighbour offsets and the neighbour counts (from `a1` being an acute corner at the top left), the mirror formula `(c, r) → (r, c)` (from the `a3` → `c1` example), and the claim in D7 that an extra stone never hurts. No page describes passing, takeback, or how a swap is written down.
