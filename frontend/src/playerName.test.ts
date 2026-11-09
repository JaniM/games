import { describe, expect, it } from "vitest";
import { playerName } from "./playerName";

describe("playerName", () => {
  it("shows an account's name as it is", () => {
    expect(playerName("ada", false, 0)).toBe("ada");
  });

  it("marks a guest's name, so that it can't pass for an account's", () => {
    expect(playerName("ada", true, 0)).toBe("ada (guest)");
    expect(playerName("Ada Lovelace", true, 1)).toBe("Ada Lovelace (guest)");
  });

  it("calls a player with no name by their seat, with no mark: it is no username", () => {
    expect(playerName(null, true, 0)).toBe("Player 1");
    expect(playerName(null, true, 1)).toBe("Player 2");
    expect(playerName(undefined, false, 1)).toBe("Player 2");
  });

  it("does not mark the bot, or a player who has deleted themselves: they are not guests", () => {
    expect(playerName("Bot", false, 1)).toBe("Bot");
    expect(playerName("Deleted player", false, 0)).toBe("Deleted player");
  });

  it("marks a guest who has chosen to be called as an account is, or as the bot is", () => {
    expect(playerName("Bot", true, 1)).toBe("Bot (guest)");
    expect(playerName("Deleted player", true, 0)).toBe("Deleted player (guest)");
  });
});
