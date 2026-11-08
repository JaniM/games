/** A game the site offers. The front page lists these. */
export interface GameInfo {
  /** URL slug: its games live at `/games/<id>/<game id>`. */
  id: string;
  name: string;
  /** One or two sentences for the front page card. */
  description: string;
  players: string;
  /** Can be played against the computer, which the new game dialog then offers. */
  bot: boolean;
}

/**
 * The catalog is static content, not client state, so it is a plain constant
 * rather than a millpond table. Add a game here to list it on the front page.
 */
export const GAMES: readonly GameInfo[] = [
  {
    id: "long-backgammon",
    name: "Long backgammon",
    description:
      "Race all fifteen of your checkers around the board and bear them off first. No hitting, only blocking.",
    players: "2 players",
    bot: true,
  },
];
