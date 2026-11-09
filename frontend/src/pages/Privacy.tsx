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
 * are what it describes, and what deleting a user does is `remove_user` in
 * `backend/src/account.rs`.
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

      <h2>Guests and accounts</h2>
      <p>
        You can use the site without an account. The first time you open it, it creates an
        anonymous user for your browser, a guest: a random id and a secret access token. Your
        browser keeps them and sends the token with each request to show that it is you.
      </p>
      <p>
        To get to your games from another device, you can make an account from the menu in the top
        right corner. It needs a username and a password, and no email address. Your guest becomes
        the account, so your games stay with you, and the guest’s access token is deleted. There is
        no email to send a link to, so a lost password can’t be reset.
      </p>
      <p>
        Your username is your name in games. Nobody else can have it, whatever its case, and you
        can’t change it later. It replaces the display name you had as a guest. A guest’s name is
        only what they typed, so other players see it with “(guest)” after it.
      </p>
      <p>
        Signing in gives that browser a session: an access token of its own. A session that has not
        been used for 30 days stops working, and signing out ends it at once.
      </p>

      <h2>What the site keeps</h2>
      <p>On the server:</p>
      <ul>
        <li>your user id, and when it was made;</li>
        <li>your access token, if you are a guest;</li>
        <li>
          if you have an account: your username, your password as a hash that can’t be turned back
          into the password, and for each session a hash of its token, when it was made and when it
          was last used;
        </li>
        <li>
          your display name, if you are a guest and pick one (up to 32 characters). If you have an
          account, your username is your name;
        </li>
        <li>
          every game you are in: who sat where, the game’s state, and when the game was made and
          last changed.
        </li>
      </ul>
      <p>A game against the bot is kept the same way.</p>
      <p>
        In your browser, in its local storage: your user id and access token, and your username if
        you have an account (<code>games.session</code>), and the sound volume (
        <code>games.volume</code>).
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
          If you have an account, your username is shown as your name. A guest’s name is shown with
          “(guest)” after it, so that it can’t pass for an account’s.
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
        Users and games are kept until you delete your user, or until {operator.name} deletes them.
        There is no other time limit, apart from the 30 days a session lasts unused.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>
          If you are a guest, you can change your display name at any time, from the account menu in
          the top right corner. The name of an account is its username, which can’t be changed.
        </li>
        <li>You can sign out from the same menu, which ends that browser’s session.</li>
        <li>
          <strong>You can delete your user</strong> from the same menu, whether you have an account
          or are a guest. Your username (your name), password hash, sessions and display name are deleted. Games
          you are playing against another person are forfeited, so they win, and stay for them with
          you shown as “Deleted player”, as do your finished games against other people. Games
          against the bot, and games nobody else has joined, are deleted. It can’t be undone.
        </li>
        <li>
          Clearing this site’s data in your browser makes it forget you. If you are a guest, the
          next visit starts a new anonymous user, and the games of the old one can’t be opened
          again. They stay on the server. If you have an account, you sign in again.
        </li>
        <li>To have your games deleted, write to {mail} with the links to them.</li>
      </ul>

      <p>
        <Link to="/">← Back to the games</Link>
      </p>
    </main>
  );
}
