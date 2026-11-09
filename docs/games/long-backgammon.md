# Long backgammon: rules spec

This is the source of truth for the rules of long backgammon on this site (also called long nardy, narde, or "длинные нарды"). Any rules engine, move validator, UI hint or test must follow it.

- **Do not silently deviate.** If the code needs a rule this file doesn't cover, or the file looks wrong, stop and ask the user. Then update this file in the same change.
- **Rules only.** UI, live versus asynchronous play, clocks, accounts and matchmaking are not covered here.
- **Open choices** are in [Decisions](#decisions). The sources disagree or are silent on those points, and each entry says what we chose.
- Last checked against sources: 2026-11-08 (see [Sources](#sources)).

## Overview

Two players, 15 checkers each, one pair of dice. Both players move their checkers the same way around the board (counter-clockwise), starting from one point each (the "head") and ending in their last quadrant (their "home"). **There is no hitting.** A point holding any opposing checker is simply blocked. The first player to bear off all 15 checkers wins, unless the other player gives up first (a forfeit, [D10](#decisions)). There is no doubling cube.

## Coordinates

Every rule below is written in the **own index** of the player being talked about: points are numbered 1–24 along that player's path of travel.

- Point 1 is the **head** (start). Points 1–6, 7–12, 13–18 and 19–24 are the four quadrants. Points 19–24 are the **home**.
- A checker only moves to higher indexes. It never wraps and never goes backwards. From point `p`, a die `d` leads to `p + d`, which must be ≤ 24 (except when bearing off).
- The board is a ring of 24 points, and the players' heads are half a ring apart. The same physical point has two indexes, one per player:
  `opponent_index = own_index + 12` if `own_index ≤ 12`, else `own_index − 12`.
  So a player's head (1) is the opponent's point 13, and a player's home (19–24) is the opponent's points 7–12.
- Internally, a ring position `r` in `0..23` is a convenient shared coordinate, with White's index `i` at `r = i − 1` and Black's index `j` at `r = (j − 1 + 12) mod 24`.
- **Physical point numbers (for cross-reference with Russian-language sources and diagrams):** White's index `i` is physical point `25 − i`. Black's index `j` is physical point `((12 − j) mod 24) + 1`. So White's head is point 24 and Black's is point 12. White's home is points 1–6 and Black's is 13–18. The heads are in diagonally opposite corners. The site labels the board and its move lists with these numbers, so that both players (and anyone watching) name a point the same way. Each player's board is still turned to put their own head top right.

"White" is the player who makes the first turn of the game, and "Black" is the other. Colours are assigned that way, so "White starts" always holds.

## Setup and starting player

- Each player starts with all 15 checkers on their own point 1 (the head).
- To decide who starts, each player rolls one die. The higher roll is White and moves first. Ties are re-rolled. (An implementation may pick the starter at random.)
- The starter then rolls both dice normally for the first turn. The decider roll is not used as a move.

## A turn

1. The player to move rolls two dice.
2. The player plays the dice one at a time. Each die moves one checker forward by exactly that many points. The player may choose which die to play first.
3. One checker may be moved by both dice, one after the other. Each step is its own move, and the intermediate point must be a legal landing point.
4. **Doubles** give four moves of the rolled number instead of two.
5. A die that cannot be played is lost. A player who cannot play any die loses the turn. A player may never pass voluntarily.
6. **Undo (site rule).** While the turn is in progress, the player may take back the steps they have played this turn, the last one first. The checker goes back where it was and its die is back to play. The roll cannot be taken back: the dice stay the same. A turn ends as soon as nothing is left to play, so the step that ends it is final and a finished turn is never reopened. (See [D7](#decisions).)

## Legal single move

A single move takes one checker from point `p` to point `p + d` (or bears it off, see below). It is legal only if all of these hold:

1. **Open landing point.** The target point holds no opposing checker. Own checkers may share a point in any number. Opposing checkers on the intermediate points a die jumps over don't matter. A die is a single hop.
2. **On the board.** `p + d ≤ 24`, unless the move is a legal bear-off.
3. **Head rule.** Only one checker may leave the head (point 1) per turn. The one exception is a player's own first turn of the game: on a roll of 3-3, 4-4 or 6-6 that player may take two checkers off the head. (See [D1](#decisions).)
4. **Prime rule.** The move must not leave the mover with a forbidden block (see below).

### Prime rule (no six in a row in front of all opposing checkers)

A **block** is six or more points, consecutive in the **opponent's** path order, that all hold at least one of the mover's checkers. "Consecutive in the opponent's path order" means opponent indexes `k, k+1, …, k+5` with `1 ≤ k ≤ 19`. The run never wraps through the opponent's point 24 to point 1, because that would not be a barrier on the opponent's path. It does cross the mover's own wrap, since the mover's 24 and 1 are the opponent's 12 and 13, which are adjacent.

A move that creates a block is **illegal unless at least one opposing checker is ahead of it**. That means a checker standing on a point of the opponent's path with a higher opponent index than the block's last point. For a longer run, use the run's last point. Opposing checkers behind the block, and borne-off checkers, don't count.

- The check applies to the position **after each single checker move**, not only after the whole turn. (See [D3](#decisions).)
- It only constrains moves that create or extend a block. Existing legal blocks never become illegal later.
- A move that is illegal because of this rule is just not available. The must-play rules below then apply to what is left.

## Choosing among moves: the must-play rules

1. **Play as many dice as possible.** If some order of moves plays both dice (or more of a double's four), the player must pick an order that does, even if it is worse for them. This includes choosing which die to play first, which checker to move, and whether to bring a second checker off the head on the exceptional first turn.
2. **If only one die can be played, play the larger.** This applies when either die can be played alone but no order plays both. If only one of the two dice can be played at all, that one is played.
3. For doubles, play as many of the four moves as possible. Rule 2 does not arise because both dice are equal.

## Bearing off

- A player may bear off only when **all 15 of their checkers are in their home** (points 19–24). Checkers that have already been borne off don't count against this.
- A checker on point `p` is `25 − p` pips from bearing off.
- A die `d` can bear off a checker on point `25 − d`.
- **Overshoot.** If the die is larger than the distance of a checker, it may bear off that checker only if the mover has **no checker on a farther point** (a lower index in home). So with no checker on `25 − d`, the die bears off the checker on the farthest occupied home point, provided that point is nearer than `d` pips.
- A die may always be played as an ordinary move inside the home instead, if that move is legal. The choice between a bear-off and an in-home move is the player's.
- Moving within the home is subject to the prime rule like any other move.
- A bear-off cannot create a block.

## End of the game and scoring

- The player who bears off all 15 checkers first wins.
- **Oyn:** the loser has borne off at least one checker. The winner scores **1 point**.
- **Mars:** the loser has borne off no checkers. The winner scores **2 points**.
- **Draw rule (last throw).** White always moves first, so if **White** bears off the 15th checker, **Black gets one last turn**. If Black bears off all 15 checkers on that turn, the game is a **draw**. Otherwise White wins. If Black bears off the 15th checker first, the game ends at once. Mars is judged after Black's last turn. (See [D5](#decisions).)
- **Forfeit (site rule).** A player may give up at any time in a game that has started and is not over, on either turn and even in the middle of their own. The other player wins and scores **1 point**, whatever either side has borne off. (See [D10](#decisions).)
- Coke (3 points) and home mars (4 points) are informal and are **not used**.

## Decisions

Points where the sources are silent or disagree. The entry in the Choice column is what the code must do until the user says otherwise.

| ID | Question | Choice | Notes |
|---|---|---|---|
| D1 | Whose first turn gets the two-from-the-head exception on 3-3, 4-4, 6-6? | **Each player's own first turn.** | The English Wikipedia Nard page says "the first turn". The Russian Wikipedia example applies it to Black's first head move too. A search summary said the Federation rules (Art. 20.3) give it to the second player only. That claim is **unverified**: I did not read the source. The exception is permitted, not mandatory, but the must-play rule forces it for these three doubles, because one head checker plays fewer of the dice. |
| D2 | Which form of the prime rule? | **Classic.** Six or more in a row in front of the opponent's checkers is illegal unless an opposing checker is ahead of it. | Both Wikipedias say this. A search summary says the Federation rules (Art. 20.5) allow six in a row and ban only a position that leaves **all 15** opposing checkers unable to move. That is **unverified**. If the user wants Federation play, this is the rule to change. |
| D3 | Is the prime rule checked after every single move, or at the end of the turn? | **After every single checker move.** | No source says. This keeps move-by-move validation simple. |
| D4 | What counts as "consecutive" for a block? | **Opponent's path order, no wrap through the opponent's 24→1.** | No source defines it. This follows "the six points in front of a checker" (Russian Wikipedia) and the fact that one die moves at most 6. |
| D5 | Is there a last-throw draw rule? | **Yes**, as described above. | The English Wikipedia Long Nardy page and the Russian page both describe it as the Federation/tournament rule. Many online apps skip it. How mars interacts with the last throw is not stated by any source. We judge mars after the last throw. |
| D6 | Overshoot when bearing off. | **Standard backgammon overshoot.** | The Russian page says "if there are no checkers on the higher points, bear off from the lower ones". The English page is silent on the larger-die case. |
| D7 | May a player take back a step? | **Yes, within the turn in progress; never the roll, and never the step that ends the turn.** | Not a rule of the sources: a site feature the user asked for on 2026-11-08, with this scope chosen from three (this one, an explicit "end turn" confirmation, and a takeback up to the opponent's roll). Undoing only returns to a position the player already had, so every rule above still holds. The head rule, the must-play rules and the prime rule are worked out again from the restored position. The opponent sees each step and each undo as it happens. |
| D8 | Which die bears off the selected checker when two different dice could? | **The larger die, in the site's UI.** | Not a rule of the sources: a site decision the user made on 2026-11-08. The bear-off button shows no die, so it cannot ask. This removes the player's choice of die in those positions, which can matter for what the other die may play. The server still accepts either die; only this client makes the choice, so it is the one place to change if the choice should come back. |
| D9 | May the site play several dice of one checker with a single click (a combined move)? | **Yes, as the same steps one after the other.** The server lists every line of two or more steps by one checker, each step legal in the position the steps before it lead to, and the client sends them as ordinary moves, a short pause apart. Where a 6 then a 3 and a 3 then a 6 reach the same point, the line the server lists first is played: the smaller die first. The bear-off tray plays one die when one can bear the checker off (the larger, as in D8), and several dice only when no single die can. | Not a rule of the sources: a site feature the user asked for on 2026-11-09. A combined move adds no rule: it is the "one checker may be moved by both dice, one after the other" of A turn, 3, so the intermediate point is a legal landing point, the prime and head rules are judged after each step, and the must-play rules apply to every step. The opponent sees each step as it happens, and an undo takes them back one at a time. The choice of order where two reach the same point cannot change the position the turn ends in, but it does change the point the checker passes over, which is only seen on the board. |
| D10 | May a player give up, and what does it score? | **Yes, at any time in a game that has started and is not over, on either turn and even in the middle of a turn. The other player wins and scores 1 point, whatever either side has borne off.** A forfeit ends the game at once: there is no last throw after it, and mars does not apply. | Not a rule of the sources: a site feature the user asked for on 2026-11-09, with the score chosen from two (this one, and scoring it like a finished game, where a forfeiter who had borne off nothing would give the winner a mars, 2 points). A forfeit is not a move, so the turn rules do not apply to it, and it cannot be taken back. It loses in every position, including the last throw ([D5](#decisions)): if White has borne off all 15 and Black has the last throw, a forfeit by either player gives the win to the other. The site also forfeits for a player who deletes their account, in each of their games that is still being played against another person. |
| D11 | What does the bear-off tray do when no checker is selected? | **It bears off the farthest checker that a single die can bear off, with that die alone** (the larger of two, as in D8). If no single die bears anything off, the tray offers nothing. A checker that only several dice in a row could bear off is not a candidate. | Not a rule of the sources: a site decision the user made on 2026-11-09. "Farthest" is the lowest own index in home, the checker with the most pips to go. It takes the choice of checker away from the player in those positions, which can matter for what the other die may play. A player who wants another checker selects it first, and the tray then bears that one off (D8, D9). The server still accepts any legal step; only this client chooses. |

## Worked examples

All use each player's **own index**. They assume the points mentioned are otherwise open.

1. **Opening 6-6.** The mover takes two checkers off the head to point 7, which is allowed under D1. The other two sixes are lost, because point 7 + 6 = 13 is the opponent's head, which is occupied. (Black's first turn behaves the same, since White's head still holds at least 13 checkers.)
2. **Opening 4-4.** One head checker can play only 1→5→9, because 9 + 4 = 13 is blocked. That is two moves, and two head checkers can play four. By must-play rule 1, the mover has to take two off the head. The only possible result is two checkers on 9, with 13 still on the head.
3. **Opening 5-5** (not an exception roll). One head checker can play all four fives, 1→6→11→16→21, so a second head checker is **not** allowed.
4. **Head rule later in the game.** A player has 14 checkers on the head and one on point 8, and rolls 5-4. The player may play 1→6 with the 5. The 4 must be played by the checker on 6 or the checker on 8, **not** by a second head checker.
5. **Prime rule.** White holds points 14–18 and moves another checker to 19, making a six-point block on points 14–19. In Black's indexes that is 2–7. This is legal only if Black has a checker on Black's point 8 or higher. That is White's points 20–24 and 1–12. While every Black checker still sits on Black's point 1 (the head), the move is illegal.
6. **Larger die.** One movable checker on point 10, no other checker can move, and the opponent holds point 17. The roll is 6-1. 10→16→17 and 10→11→17 are both blocked, so only one die can be played, and it must be the 6: 10→16.
7. **Bear-off overshoot.** All checkers are home, on points 19 and 22 only. With a 5, point 20 is empty and a checker is farther back (on 19), so the 5 cannot bear off from 22. The 5 must be played 19→24. With a 3, point 22 is exactly 3 pips away, so the checker on 22 bears off. With a 6, the checker on 19 bears off.
8. **Bear-off overshoot with nothing farther.** All checkers are home, on points 21–24 only. A 6 bears off the checker on 21, the farthest one.
9. **Last throw.** White bears off the 15th checker on its turn. Black has borne off 12 checkers and gets one more turn. If Black bears off its remaining 3, the game is a draw. If not, White wins 1 point (Black has borne off at least one).
10. **Undo.** A player rolls 5-2 and plays the 5 from the head (1→6). The head is used up, so the 2 could only be played from 6. The player undoes the step: the checker is back on the head, the 5 is back to play, and the 2 may now be played from the head (1→3), or the 5 played again. After 1→6 and 6→8 the turn is over, so neither step can be undone.
11. **Forfeit.** It is White's turn and White has rolled 5-2 and played the 5. Black, who has borne off nothing, gives up. The game is over at once: White wins **1 point**, not the 2 of a mars, and the rest of White's turn is not played. Had White given up instead, Black would have won 1 point in the same way.

## Out of scope

Live versus asynchronous play, clocks and time limits, match play and colour swapping between games, ratings, spectators, UI orientation and animations, how the computer opponent chooses its moves (it plays only steps the rules above allow, so it needs no rules of its own), and the doubling cube (not part of long backgammon). Undo is covered only within a turn in progress ([D7](#decisions)); taking back a finished turn is out of scope.

## Sources

The pages were read through a summarising fetch tool, not word for word. The Russian page carries an "unreviewed" banner. Where this file says "unverified", the claim only came from a web search summary of a page I did not open.

- English Wikipedia, [Long Nardy](https://en.wikipedia.org/wiki/Long_Nardy): setup, anticlockwise movement, no landing on any opposing checker, prime, scoring, Federation draw rule.
- English Wikipedia, [Nard (game)](https://en.wikipedia.org/wiki/Nard_(game)): Long Nardy section: head rule and the 3-3 / 4-4 / 6-6 exception, "if only one [die] can be used, the higher one must be played", no hitting, prime rule, scoring.
- Russian Wikipedia, [Длинные нарды](https://ru.wikipedia.org/wiki/Длинные_нарды): physical point numbering, must-play rules and the "larger die" case, bearing off, oyn and mars, last throw, starting player.
- Search-result summaries only, **not opened**: a Federation-rules summary in a [GitHub rules-engine issue](https://github.com/brianhliou/mistboard/issues/760) (source of the D1 and D2 Federation claims), and [Long Narde Rules](https://sites.google.com/site/longnarde/en).
