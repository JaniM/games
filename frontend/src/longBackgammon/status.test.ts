import { describe, expect, it } from "vitest";
import type { Rematch } from "../features/game";
import { moving, snapshotOf, startingState } from "../fixtures";
import {
  barNameOf,
  frameText,
  lastThrowText,
  lastTurnText,
  nameOf,
  rematchStage,
  resultOf,
  stepText,
  turnText,
  viewerSeat,
} from "./status";

const snap = snapshotOf; // seats: 0 = Ada, 1 = Grace

describe("who the page is drawn for", () => {
  it("is the player's own seat", () => {
    expect(viewerSeat(1, startingState())).toBe(1);
  });

  it("is White for a spectator, and seat 0 before there is a White", () => {
    expect(viewerSeat(null, startingState({ white: 1 }))).toBe(1);
    expect(viewerSeat(null, null)).toBe(0);
  });
});

describe("names", () => {
  it("say 'You' for the viewer and the name for the other player", () => {
    expect(nameOf(snap(), 0, 0)).toBe("You");
    expect(nameOf(snap(), 1, 0)).toBe("Grace");
  });

  it("fall back to 'Player N' for a player without a name, and for both when watching", () => {
    expect(nameOf(snap({ playerNames: [null, null] }), 1, 0)).toBe("Player 2");
    expect(nameOf(snap(), 0, null)).toBe("Ada");
  });

  it("label the bar of an empty seat as waiting", () => {
    const waiting = snap({ players: ["user-a"], playerNames: ["Ada"], state: null });
    expect(barNameOf(waiting, 1, 0)).toBe("Waiting for an opponent…");
    expect(barNameOf(waiting, 0, 0)).toBe("Ada (you)");
  });

  it("label your own bar 'You' if you have no name", () => {
    expect(barNameOf(snap({ playerNames: [null, "Grace"] }), 0, 0)).toBe("You");
  });
});

describe("turnText", () => {
  it("says the game is waiting for a second player", () => {
    const waiting = snap({ players: ["user-a"], playerNames: ["Ada"], state: null });
    expect(turnText(waiting, 0)).toBe("Waiting for an opponent to join.");
  });

  it("asks the mover to roll, and tells the others who is rolling", () => {
    expect(turnText(snap(), 0)).toBe("Your turn. Roll the dice.");
    expect(turnText(snap(), 1)).toBe("Waiting for Ada to roll.");
    expect(turnText(snap(), null)).toBe("Waiting for Ada to roll.");
  });

  it("counts the dice left once they are rolled", () => {
    const state = startingState(moving([6, 3], [{ from: 1, die: 6 }]));
    expect(turnText(snap({ state }), 0)).toBe("Your turn. Pick a checker to move (2 dice left).");
    expect(turnText(snap({ state }), 1)).toBe("Waiting for Ada to move.");

    const last = startingState(moving([6, 3], [], [{ from: 1, die: 6 }], [3]));
    expect(turnText(snap({ state: last }), 0)).toContain("(1 die left)");
  });

  it("is empty when the game is over", () => {
    const state = startingState({ phase: { type: "over", winner: 0, points: 1 } });
    expect(turnText(snap({ state }), 0)).toBe("");
  });
});

describe("resultOf", () => {
  const over = (winner: 0 | 1 | null, points: number) =>
    snap({ state: startingState({ phase: { type: "over", winner, points } }) });

  it("is null while the game is on", () => {
    expect(resultOf(snap(), 0)).toBeNull();
  });

  it("says who won and what it is worth", () => {
    expect(resultOf(over(0, 1), 0)).toEqual({ title: "You won", detail: "1 point", won: true });
    expect(resultOf(over(0, 1), 1)).toEqual({ title: "Ada won", detail: "1 point", won: false });
    expect(resultOf(over(1, 1), null)).toEqual({ title: "Grace won", detail: "1 point", won: false });
  });

  it("calls a double win a mars", () => {
    expect(resultOf(over(1, 2), 1)).toEqual({ title: "You won", detail: "Mars: 2 points", won: true });
  });

  it("calls it a draw", () => {
    expect(resultOf(over(null, 0), 0)).toEqual({ title: "Draw", detail: "", won: false });
  });
});

describe("what the last turn was", () => {
  it("is empty before any turn", () => {
    expect(lastTurnText(snap(), 0)).toBe("");
  });

  it("says a player could not move", () => {
    const state = startingState({ lastTurn: { seat: 1, dice: [6, 5], played: [] } });
    expect(lastTurnText(snap({ state }), 0)).toBe("Grace rolled 6-5 and could not move.");
    expect(lastTurnText(snap({ state }), 1)).toBe("You rolled 6-5 and could not move.");
  });

  it("lists the moves in the numbers both players share, whoever is reading", () => {
    // Seat 0 is White. Black (seat 1) leaves its head, which is point 12, and its own
    // points 7 and 12 are 6 and 1.
    const state = startingState({
      lastTurn: { seat: 1, dice: [6, 5], played: [{ from: 1, die: 6 }, { from: 7, die: 5 }] },
    });
    expect(lastTurnText(snap({ state }), 0)).toBe("Grace rolled 6-5 and played 12→6, 6→1.");
    expect(lastTurnText(snap({ state }), 1)).toBe("You rolled 6-5 and played 12→6, 6→1.");
    expect(lastTurnText(snap({ state }), null)).toBe("Grace rolled 6-5 and played 12→6, 6→1.");
  });

  it("counts from the head the same way for White", () => {
    const state = startingState({
      lastTurn: { seat: 0, dice: [6, 5], played: [{ from: 1, die: 6 }, { from: 7, die: 5 }] },
    });
    expect(lastTurnText(snap({ state }), 0)).toBe("You rolled 6-5 and played 24→18, 18→13.");
    expect(lastTurnText(snap({ state }), 1)).toBe("Ada rolled 6-5 and played 24→18, 18→13.");
  });

  it("writes a step that bears off as 'off'", () => {
    expect(stepText({ from: 22, die: 4 }, 0, 0)).toBe("3→off");
    expect(stepText({ from: 22, die: 4 }, 1, 0)).toBe("15→off");
  });
});

describe("lastThrowText", () => {
  it("warns that Black has one throw left", () => {
    const text = lastThrowText(startingState({ lastThrow: true }));
    expect(text).toBe("White has borne off everything. Black gets one last throw.");
  });

  it("is empty otherwise, and once the game is over", () => {
    expect(lastThrowText(startingState())).toBe("");
    const over = startingState({ lastThrow: true, phase: { type: "over", winner: 0, points: 1 } });
    expect(lastThrowText(over)).toBe("");
  });
});

describe("rematchStage", () => {
  const over = { type: "over", winner: 0, points: 1 } as const;
  const rematchOf = (rematch: Rematch | null) => snap({ state: startingState({ phase: over }), rematch });

  it("lets a player ask when nobody has", () => {
    expect(rematchStage(rematchOf(null), 0)).toEqual({ stage: "ask", line: "" });
    expect(rematchStage(rematchOf(null), 1)).toEqual({ stage: "ask", line: "" });
  });

  it("tells the one who asked that the other has not answered, and can be waited out or taken back", () => {
    expect(rematchStage(rematchOf({ type: "offered", by: 0 }), 0)).toEqual({
      stage: "waiting",
      line: "Waiting for Grace to accept the rematch…",
    });
  });

  it("asks the other player to answer, by name", () => {
    expect(rematchStage(rematchOf({ type: "offered", by: 0 }), 1)).toEqual({
      stage: "answer",
      line: "Ada wants a rematch.",
    });
    expect(rematchStage(rematchOf({ type: "offered", by: 1 }), 0)).toEqual({
      stage: "answer",
      line: "Grace wants a rematch.",
    });
  });

  it("falls back to 'Player N' for an opponent without a name", () => {
    const snapshot = { ...rematchOf({ type: "offered", by: 1 }), playerNames: ["Ada", null] };

    expect(rematchStage(snapshot, 0).line).toBe("Player 2 wants a rematch.");
  });

  it("tells the one who was turned down, and says nothing to the one who said no", () => {
    const declined = rematchOf({ type: "declined", by: 0 });

    expect(rematchStage(declined, 0)).toEqual({ stage: "ask", line: "Grace declined the rematch." });
    expect(rematchStage(declined, 1)).toEqual({ stage: "ask", line: "" });
  });

  it("points everyone, spectators too, at the new game once it exists", () => {
    const started = rematchOf({ type: "accepted", gameId: "nextgame234" });

    for (const seat of [0, 1, null] as const) {
      expect(rematchStage(started, seat)).toEqual({
        stage: "started",
        line: "The rematch has started.",
        gameId: "nextgame234",
      });
    }
  });

  it("offers a spectator nothing to press", () => {
    expect(rematchStage(rematchOf(null), null)).toEqual({ stage: "closed", line: "" });
    expect(rematchStage(rematchOf({ type: "offered", by: 0 }), null)).toEqual({ stage: "closed", line: "" });
  });
});

describe("frameText, for a position of a game in review", () => {
  const look = (state: ReturnType<typeof startingState>, mySeat: 0 | 1 | null = null) =>
    frameText(snap(), state, mySeat);

  it("calls the first position the start of the game", () => {
    expect(look(startingState())).toEqual({ title: "Start of the game", detail: "" });
  });

  it("says who rolled what, when the dice are rolled and nothing is played", () => {
    const rolled = startingState(moving([6, 3], [{ from: 1, die: 6 }]));

    expect(look(rolled).title).toBe("Ada rolled 6-3");
    expect(look(rolled, 0).title).toBe("You rolled 6-3");
    expect(look(rolled, 1).title).toBe("Ada rolled 6-3");
  });

  it("says the last step of the turn in progress, in the numbering both players share", () => {
    const stepped = startingState(moving([6, 3], [{ from: 7, die: 3 }], [{ from: 1, die: 6 }], [3]));

    // Seat 0 is White: its point 1 is point 24, and its point 7 is 18.
    expect(look(stepped).title).toBe("Ada played 24→18");
  });

  it("names the mover by their seat, for either player", () => {
    const grace = startingState({
      turn: 1,
      ...moving([2, 1], [], [{ from: 1, die: 2 }], [1]),
    });

    // Seat 1 is Black: its point 1 is point 12.
    expect(look(grace).title).toBe("Grace played 12→10");
    expect(look(grace, 1).title).toBe("You played 12→10");
  });

  it("says the step that ended a turn, which is in the turn before once the turn has passed", () => {
    const passed = startingState({
      turn: 1,
      turns: [1, 0],
      lastTurn: { seat: 0, dice: [6, 3], played: [{ from: 1, die: 6 }, { from: 7, die: 3 }] },
    });

    expect(look(passed).title).toBe("Ada played 18→15");
  });

  it("says a turn that could not be played", () => {
    const lost = startingState({
      turn: 1,
      turns: [1, 0],
      lastTurn: { seat: 0, dice: [6, 5], played: [] },
    });

    expect(look(lost).title).toBe("Ada rolled 6-5 and could not move");
  });

  it("says a step off the board", () => {
    const off = startingState({
      turn: 1,
      turns: [30, 29],
      off: [1, 0],
      lastTurn: { seat: 0, dice: [5, 6], played: [{ from: 20, die: 5 }] },
    });

    expect(look(off).title).toBe("Ada played 5→off");
  });

  it("warns, in the position after White has borne off everything, that Black has one throw left", () => {
    const last = startingState({ turn: 1, lastThrow: true, off: [15, 4] });

    expect(look(last).detail).toBe("White has borne off everything. Black gets one last throw.");
  });

  it("gives the result in the last position, for the one who won and the one who is watching", () => {
    const over = startingState({
      off: [15, 3],
      turns: [40, 39],
      phase: { type: "over", winner: 0, points: 1 },
      lastTurn: { seat: 0, dice: [1, 2], played: [{ from: 24, die: 1 }] },
    });

    expect(look(over, 0)).toEqual({ title: "You played 1→off", detail: "Game over. You won, 1 point." });
    expect(look(over, null).detail).toBe("Game over. Ada won, 1 point.");
  });

  it("gives a mars its two points, and a draw no points", () => {
    const mars = startingState({
      phase: { type: "over", winner: 1, points: 2 },
      lastTurn: { seat: 1, dice: [1, 2], played: [{ from: 24, die: 1 }] },
    });
    const draw = startingState({
      phase: { type: "over", winner: null, points: 0 },
      lastTurn: { seat: 1, dice: [1, 2], played: [{ from: 24, die: 1 }] },
    });

    expect(look(mars).detail).toBe("Game over. Grace won, mars: 2 points.");
    expect(look(draw).detail).toBe("Game over. Draw.");
  });

  it("tells the result of the position it is given, not of the game as it stands now", () => {
    // The snapshot is of a game that is over, but the position in review is from the middle of it.
    const live = snap({
      state: startingState({ phase: { type: "over", winner: 0, points: 1 } }),
    });
    const middle = startingState(moving([6, 3], []));

    expect(frameText(live, middle, null).detail).toBe("");
  });
});
