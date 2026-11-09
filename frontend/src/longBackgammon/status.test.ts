import { describe, expect, it } from "vitest";
import type { Rematch } from "../features/game";
import { moving, snapshotOf, startingState } from "../fixtures";
import {
  barNameOf,
  frameText,
  lastThrowText,
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

  describe("of a guest", () => {
    // Both are guests, and Grace has typed the name of an account.
    const guests = snap({ playerGuests: [true, true] });

    it("carry a guest indicator in a sentence and on the bar, for the other player", () => {
      expect(nameOf(guests, 1, 0)).toBe("Grace (guest)");
      expect(barNameOf(guests, 1, 0)).toBe("Grace (guest)");
    });

    it("carry none for the viewer's own seat, who says 'You' and '(you)'", () => {
      expect(nameOf(guests, 0, 0)).toBe("You");
      expect(barNameOf(guests, 0, 0)).toBe("Ada (you)");
    });

    it("carry it for both when watching", () => {
      expect(nameOf(guests, 0, null)).toBe("Ada (guest)");
      expect(barNameOf(guests, 1, null)).toBe("Grace (guest)");
    });

    it("are not marked when they have no name: 'Player 2' is no username", () => {
      const nameless = snap({ playerNames: [null, null], playerGuests: [true, true] });

      expect(nameOf(nameless, 1, 0)).toBe("Player 2");
      expect(barNameOf(nameless, 1, 0)).toBe("Player 2");
    });

    it("leave an account unmarked beside a guest of the same name", () => {
      const same = snap({ playerNames: ["Ada", "Ada"], playerGuests: [false, true] });

      expect(nameOf(same, 0, null)).toBe("Ada");
      expect(nameOf(same, 1, null)).toBe("Ada (guest)");
    });

    it("leave the bot unmarked", () => {
      const bot = snap({ playerNames: ["Ada", "Bot"], playerGuests: [true, false] });

      expect(barNameOf(bot, 1, 0)).toBe("Bot");
      expect(nameOf(bot, 1, 0)).toBe("Bot");
    });

    it("run through what is said about the game: whose turn, who won, who forfeited, the rematch", () => {
      expect(turnText(guests, 0)).toBe("Your turn. Roll the dice.");
      expect(turnText(guests, 1)).toBe("Waiting for Ada (guest) to roll.");
      const lost = snap({
        playerGuests: [true, true],
        state: startingState({ phase: { type: "over", winner: 1, points: 1, forfeited: true } }),
      });
      expect(resultOf(lost, 0)).toMatchObject({ title: "Grace (guest) won", detail: "You forfeited" });
      expect(resultOf(lost, 1)).toMatchObject({ title: "You won", detail: "Ada (guest) forfeited" });
      const over = startingState({ phase: { type: "over", winner: 0, points: 1, forfeited: false } });
      const asked = snap({ playerGuests: [true, true], state: over, rematch: { type: "offered", by: 1 } });
      expect(rematchStage(asked, 0).line).toBe("Grace (guest) wants a rematch.");
    });
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
    const state = startingState({ phase: { type: "over", winner: 0, points: 1, forfeited: false } });
    expect(turnText(snap({ state }), 0)).toBe("");
  });
});

describe("resultOf", () => {
  const over = (winner: 0 | 1 | null, points: number) =>
    snap({ state: startingState({ phase: { type: "over", winner, points, forfeited: false } }) });

  it("is null while the game is on", () => {
    expect(resultOf(snap(), 0)).toBeNull();
  });

  it("says who won and what it is worth", () => {
    expect(resultOf(over(0, 1), 0)).toEqual({ title: "You won", detail: "1 point", forfeited: false, won: true });
    expect(resultOf(over(0, 1), 1)).toEqual({ title: "Ada won", detail: "1 point", forfeited: false, won: false });
    expect(resultOf(over(1, 1), null)).toEqual({ title: "Grace won", detail: "1 point", forfeited: false, won: false });
  });

  it("calls a double win a mars", () => {
    expect(resultOf(over(1, 2), 1)).toEqual({ title: "You won", detail: "Mars: 2 points", forfeited: false, won: true });
  });

  it("calls it a draw", () => {
    expect(resultOf(over(null, 0), 0)).toEqual({ title: "Draw", detail: "", forfeited: false, won: false });
  });

  describe("after a forfeit", () => {
    const forfeit = (winner: 0 | 1) =>
      snap({ state: startingState({ phase: { type: "over", winner, points: 1, forfeited: true } }) });

    it("says who gave up instead of what the win is worth", () => {
      expect(resultOf(forfeit(0), 0)).toEqual({
        title: "You won",
        detail: "Grace forfeited",
        forfeited: true,
        won: true,
      });
      expect(resultOf(forfeit(0), 1)).toEqual({
        title: "Ada won",
        detail: "You forfeited",
        forfeited: true,
        won: false,
      });
    });

    it("names both for someone who is watching", () => {
      expect(resultOf(forfeit(1), null)).toMatchObject({ title: "Grace won", detail: "Ada forfeited" });
    });

    it("names a player who has no name, as everywhere else", () => {
      const nameless = snap({
        playerNames: [null, null],
        state: startingState({ phase: { type: "over", winner: 1, points: 1, forfeited: true } }),
      });

      expect(resultOf(nameless, null)).toMatchObject({ title: "Player 2 won", detail: "Player 1 forfeited" });
    });
  });
});

describe("steps", () => {
  it("are written in the numbers both players share, whoever moves", () => {
    // Seat 0 is White. Black (seat 1) leaves its head, which is point 12, and its own
    // points 7 and 12 are 6 and 1.
    expect(stepText({ from: 1, die: 6 }, 1, 0)).toBe("12→6");
    expect(stepText({ from: 7, die: 5 }, 1, 0)).toBe("6→1");
    expect(stepText({ from: 1, die: 6 }, 0, 0)).toBe("24→18");
    expect(stepText({ from: 7, die: 5 }, 0, 0)).toBe("18→13");
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
    const over = startingState({ lastThrow: true, phase: { type: "over", winner: 0, points: 1, forfeited: false } });
    expect(lastThrowText(over)).toBe("");
  });
});

describe("rematchStage", () => {
  const over = { type: "over", winner: 0, points: 1, forfeited: false } as const;
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
      phase: { type: "over", winner: 0, points: 1, forfeited: false },
      lastTurn: { seat: 0, dice: [1, 2], played: [{ from: 24, die: 1 }] },
    });

    expect(look(over, 0)).toEqual({ title: "You played 1→off", detail: "Game over. You won, 1 point." });
    expect(look(over, null).detail).toBe("Game over. Ada won, 1 point.");
  });

  it("gives a mars its two points, and a draw no points", () => {
    const mars = startingState({
      phase: { type: "over", winner: 1, points: 2, forfeited: false },
      lastTurn: { seat: 1, dice: [1, 2], played: [{ from: 24, die: 1 }] },
    });
    const draw = startingState({
      phase: { type: "over", winner: null, points: 0, forfeited: false },
      lastTurn: { seat: 1, dice: [1, 2], played: [{ from: 24, die: 1 }] },
    });

    expect(look(mars).detail).toBe("Game over. Grace won, mars: 2 points.");
    expect(look(draw).detail).toBe("Game over. Draw.");
  });

  it("says who forfeited, keeping a name's capital and lowering \"You\" in the middle of the sentence", () => {
    const forfeit = (winner: 0 | 1) =>
      startingState({
        phase: { type: "over", winner, points: 1, forfeited: true },
        lastTurn: { seat: 0, dice: [1, 2], played: [{ from: 24, die: 1 }] },
      });

    expect(look(forfeit(0), 0).detail).toBe("Game over. You won, Grace forfeited.");
    expect(look(forfeit(0), 1).detail).toBe("Game over. Ada won, you forfeited.");
    expect(look(forfeit(1), null).detail).toBe("Game over. Grace won, Ada forfeited.");
  });

  it("tells the result of the position it is given, not of the game as it stands now", () => {
    // The snapshot is of a game that is over, but the position in review is from the middle of it.
    const live = snap({
      state: startingState({ phase: { type: "over", winner: 0, points: 1, forfeited: false } }),
    });
    const middle = startingState(moving([6, 3], []));

    expect(frameText(live, middle, null).detail).toBe("");
  });
});
