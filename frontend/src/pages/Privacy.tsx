import { Link } from "../Link";
import { OPERATOR, type Operator } from "../site";

export interface PrivacyProps {
  /** Who runs the site. */
  operator?: Operator;
}

/**
 * The privacy policy. It says what the code does, so when the code changes what it stores or
 * who sees it, this page changes with it: the backend's migrations (`backend/migrations`) and
 * the browser storage keys (`features/session/credentials.ts`, `features/sound/storage.ts`)
 * are what it describes.
 */
export function Privacy({ operator = OPERATOR }: PrivacyProps) {
  const mail = <a href={`mailto:${operator.email}`}>{operator.email}</a>;
  return (
    <main className="page prose">
      <header className="page-header">
        <h1>Privacy policy</h1>
        <p>What this site stores about you, and who can see it.</p>
      </header>

      <h2>Who runs the site</h2>
      <p>
        {operator.name} runs this site. You can write to {mail} about anything on this page.
      </p>

      <h2>No sign-up</h2>
      <p>
        You don’t make an account with an email address or a password. The first time you open the
        site, it creates an anonymous user for your browser: a random id and a secret access token.
        Your browser keeps them and sends the token with each request to show that it is you.
      </p>

      <h2>What the site keeps</h2>
      <p>On the server:</p>
      <ul>
        <li>your anonymous user id and access token, and when they were made;</li>
        <li>your display name, if you pick one (up to 32 characters);</li>
        <li>
          every game you are in: who sat where, the position (the checkers, the dice, the steps
          played in the turn so far and the turn before), and when the game was made and last
          changed.
        </li>
      </ul>
      <p>A game against the bot is kept the same way.</p>
      <p>
        In your browser, in its local storage: your user id and access token (<code>games.session</code>
        ) and the sound volume (<code>games.volume</code>).
      </p>
      <p>
        Whoever hosts the site may keep ordinary access logs of their own, such as the time of a
        request and the IP address it came from.
      </p>

      <h2>Who can see what</h2>
      <ul>
        <li>
          <strong>Your opponent, and anyone who has the link to a game,</strong> can see your
          display name (or “Player 1” and “Player 2” if you have none) and every move in that game.
          Anyone with the link can watch, so share it only with people you are happy to have watch.
        </li>
        <li>
          The game also sends your anonymous user id to everyone connected to it. It is not shown on
          the page, and it is not your name.
        </li>
        <li>A game can only be opened by someone who has its link.</li>
        <li>{operator.name}, which runs the site, can read everything the server keeps.</li>
      </ul>
      <p>
        Pick a display name you are happy to have strangers read: it is not checked or kept
        private.
      </p>

      <h2>How long it is kept</h2>
      <p>
        Users and games are kept until {operator.name} deletes them. There is no time limit, and no
        button on the site to delete them yourself.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>You can change your display name at any time, from the button in the top right corner.</li>
        <li>
          Clearing this site’s data in your browser makes it forget you. The next visit starts a new
          anonymous user, and the games of the old one can’t be opened again. They stay on the
          server.
        </li>
        <li>To have your games deleted, write to {mail} with the links to them.</li>
      </ul>

      <p>
        <Link to="/">← Back to the games</Link>
      </p>
    </main>
  );
}
