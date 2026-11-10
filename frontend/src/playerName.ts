/**
 * A player's name, as the others see it.
 *
 * - An account's name is its username: nobody else has it, so it is shown as it is.
 * - A guest's name is whatever they typed, which anyone can type, an account's included. So it is
 *   followed by "(guest)": "Ada (guest)" is not the account "Ada".
 * - A guest who has typed none is "Player 2". That is no username (they have no spaces), so
 *   it needs no mark. The bots ("Easy bot", "Medium bot", "Hard bot") and a player who has
 *   deleted themselves ("Deleted player") are not guests.
 *
 * `seat` is 0-based. The viewer's own seat isn't named this way: they are "You", or "(you)".
 */
export function playerName(name: string | null | undefined, guest: boolean, seat: number): string {
  if (name == null) return `Player ${seat + 1}`;
  return guest ? `${name} (guest)` : name;
}
