import { describe, expect, it } from "vitest";
import { moving, snapshotOf, startingState } from "../fixtures";
import {
  barNameOf,
  lastThrowText,
  lastTurnText,
  nameOf,
  resultText,
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

describe("resultText", () => {
  const over = (winner: 0 | 1 | null, points: number) =>
    snap({ state: startingState({ phase: { type: "over", winner, points } }) });

  it("is empty while the game is on", () => {
    expect(resultText(snap(), 0)).toBe("");
  });

  it("says who won and what it is worth", () => {
    expect(resultText(over(0, 1), 0)).toBe("You won the game (1 point).");
    expect(resultText(over(0, 1), 1)).toBe("Ada won the game (1 point).");
    expect(resultText(over(1, 1), null)).toBe("Grace won the game (1 point).");
  });

  it("calls a double win a mars", () => {
    expect(resultText(over(1, 2), 1)).toBe("You won the game (mars, 2 points).");
  });

  it("calls it a draw", () => {
    expect(resultText(over(null, 0), 0)).toBe("The game is a draw.");
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
