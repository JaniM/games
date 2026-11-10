import type { RowOf } from "millpond";
import { useOp, useQuery } from "millpond/react";
import { type FormEvent, useState } from "react";
import { Modal } from "./Modal";
import {
  ACCOUNT_ID,
  accountRequest,
  closeAccountForm,
  openAccountForm,
  submitAccountForm,
} from "../features/account";
import { SESSION_ID, sessionFlags, sessionState, signedOutNoticeDismissed } from "../features/session";

export type AccountRequestRow = RowOf<typeof accountRequest>;

/** The most the server takes of each. The fields count UTF-16 units, so they are never looser. */
const MAX_USERNAME = 32;
const MAX_PASSWORD = 128;

interface FormCopy {
  title: string;
  /** What the button that sends it says. */
  action: string;
  /** What it says while the request is on its way. */
  busy: string;
}

const COPY: Record<"create" | "signIn" | "delete", FormCopy> = {
  create: { title: "Create an account", action: "Create account", busy: "Creating…" },
  signIn: { title: "Sign in", action: "Sign in", busy: "Signing in…" },
  delete: { title: "Delete account", action: "Delete", busy: "Deleting…" },
};

/**
 * The dialog for making an account, signing in, or deleting the user: the form that is open, if
 * one is. The fields are the form's own until it is sent; the password goes nowhere else, and
 * isn't kept once the request is done. It starts with the username the request has, so it is
 * keyed by the form (see `AccountDialogs`).
 */
export function AccountForm() {
  const request = useQuery(accountRequest.get(ACCOUNT_ID));
  // The user has an account, which is what a deletion asks the password of.
  const isAccount = useQuery(sessionState.get(SESSION_ID))?.username != null;
  const send = useOp(submitAccountForm);
  const close = useOp(closeAccountForm);
  const [username, setUsername] = useState(request?.username ?? "");
  const [password, setPassword] = useState("");
  // The sign-out has no form.
  if (!request || request.form === "signOut") return null;

  const { form } = request;
  const submitting = request.state === "submitting";
  const copy = form === "delete" && !isAccount ? { ...COPY.delete, title: "Delete my data" } : COPY[form];
  const asksName = form !== "delete";
  const asksPassword = form !== "delete" || isAccount;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!submitting) send({ username, password });
  }

  return (
    <Modal title={copy.title} locked={submitting} onClose={() => close()}>
      <form className="account-form" onSubmit={submit}>
        <FormText form={form} isAccount={isAccount} />
        {asksName && (
          <label className="field">
            <span className="field-label">Username</span>
            <input
              className="field-input"
              name="username"
              value={username}
              maxLength={MAX_USERNAME}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={submitting}
              // The password instead when the form already has the name that is wanted: signing in
              // after a signed-out notice. An account's form starts with the guest's name, which
              // may not do, so the focus is where it would be changed.
              data-autofocus={username === "" || form === "create" ? true : undefined}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
        )}
        {asksPassword && (
          <label className="field">
            <span className="field-label">Password</span>
            <input
              className="field-input"
              name="password"
              type="password"
              value={password}
              maxLength={MAX_PASSWORD}
              autoComplete={form === "create" ? "new-password" : "current-password"}
              disabled={submitting}
              data-autofocus={!asksName || (form !== "create" && username !== "") ? true : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        )}
        {request.error && (
          <p className="error" role="alert">
            {request.error}
          </p>
        )}
        <div className="modal-actions">
          <button className="button button-quiet" type="button" disabled={submitting} onClick={() => close()}>
            Cancel
          </button>
          <button className="button" type="submit" disabled={submitting} aria-busy={submitting}>
            {submitting ? copy.busy : copy.action}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** What each form says above its fields: nothing for signing in. The deletion says what happens to the games. */
function FormText({ form, isAccount }: { form: "create" | "signIn" | "delete"; isAccount: boolean }) {
  if (form === "create") {
    return (
      <>
        <p>An account lets you sign in from another device. Your games stay with you.</p>
        <p className="muted">
          Letters, digits, dots, hyphens and underscores, 3 to 32 of them. The password is 8 or more
          characters.
        </p>
      </>
    );
  }
  // Signing in needs no explaining: the fields say it.
  if (form === "signIn") return null;
  return (
    <>
      <p>
        {isAccount
          ? "This deletes your account and signs you out."
          : "This deletes you, and you start again as a new guest."}{" "}
        It can’t be undone.
      </p>
      <ul className="account-effects">
        <li>Games you are playing against another person are forfeited: they win.</li>
        <li>Games against the bot, and games nobody has joined, are deleted.</li>
        <li>Finished games against other people stay for them, with you shown as “Deleted player”.</li>
      </ul>
      {isAccount && <p className="muted">Enter your password to confirm.</p>}
    </>
  );
}

/**
 * Says that the session of an account ended without the user asking, so that they know why they
 * are a guest and don't see their games. Without it they would find the site empty and not know why.
 * Signing in from here opens the form with the account's username in it.
 */
export function SignedOutNotice() {
  // The account whose session ended, if one did.
  const username = useQuery(sessionFlags.get(SESSION_ID))?.signedOutAs;
  const open = useOp(openAccountForm);
  const dismiss = useOp(signedOutNoticeDismissed);
  if (!username) return null;

  return (
    <Modal title="You were signed out" onClose={() => dismiss()}>
      <p>
        Your session as <strong>{username}</strong> has ended, so you are playing as a guest. Sign in again to get
        your games back.
      </p>
      <div className="modal-actions">
        <button className="button button-quiet" type="button" onClick={() => dismiss()}>
          Not now
        </button>
        <button
          className="button"
          type="button"
          data-autofocus
          onClick={() => {
            open({ form: "signIn", username });
            dismiss();
          }}
        >
          Sign in
        </button>
      </div>
    </Modal>
  );
}

/** The account forms and the notice. At most one dialog is open: a form comes before the notice. */
export function AccountDialogs() {
  const request = useQuery(accountRequest.get(ACCOUNT_ID));
  const signedOutAs = useQuery(sessionFlags.get(SESSION_ID))?.signedOutAs;

  // Keyed by the form, so that moving from one to another starts with empty fields.
  if (request && request.form !== "signOut") return <AccountForm key={request.form} />;
  if (signedOutAs && !request) return <SignedOutNotice />;
  return null;
}
