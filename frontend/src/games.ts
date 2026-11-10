/** A game the site offers. The front page lists these. */
export interface GameInfo {
  /** URL slug: its games live at `/games/<id>/<game id>`. */
  id: string;
  /** Also `Game::NAME` in the backend, which puts it in the preview of a link to a game: keep the two the same. */
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
  {
    id: "ultimate-tic-tac-toe",
    name: "Ultimate tic-tac-toe",
    description:
      "Nine tic-tac-toe boards in one. The cell you mark decides which board your opponent plays in next. Win three boards in a row.",
    players: "2 players",
    bot: true,
  },
  {
    id: "hex",
    name: "Hex",
    description:
      "Take turns placing stones on a board of hexagons. Join your two sides of the board before your opponent joins theirs.",
    players: "2 players",
    bot: false,
  },
];
