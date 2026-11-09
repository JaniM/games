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
} from "./features/account";
import { SESSION_ID, sessionFlags, sessionState, signedOutNoticeDismissed } from "./features/session";

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

export interface AccountFormProps {
  /** The form that is open, and where its request stands. Never the sign-out, which has no form. */
  request: AccountRequestRow & { form: "create" | "signIn" | "delete" };
  /** The user has an account, which is what a deletion asks the password of. */
  isAccount: boolean;
  onSubmit: (username: string, password: string) => void;
  onClose: () => void;
}

/**
 * The dialog for making an account, signing in, or deleting the user. The fields are the
 * form's own until it is sent; the password goes nowhere else, and isn't kept once the request
 * is done. Everything it shows comes from its props, so it can be rendered without a db.
 */
export function AccountForm({ request, isAccount, onSubmit, onClose }: AccountFormProps) {
  const [username, setUsername] = useState(request.username);
  const [password, setPassword] = useState("");
  const { form } = request;
  const submitting = request.state === "submitting";
  const copy = form === "delete" && !isAccount ? { ...COPY.delete, title: "Delete my data" } : COPY[form];
  const asksName = form !== "delete";
  const asksPassword = form !== "delete" || isAccount;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!submitting) onSubmit(username, password);
  }

  return (
    <Modal title={copy.title} locked={submitting} onClose={onClose}>
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
          <button className="button button-quiet" type="button" disabled={submitting} onClick={onClose}>
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

export interface SignedOutNoticeProps {
  /** The account whose session ended. */
  username: string;
  onSignIn: () => void;
  onDismiss: () => void;
}

/**
 * Says that the session of an account ended without the user asking, so that they know why they
 * are a guest and don't see their games. Without it they would find the site empty and not know why.
 */
export function SignedOutNotice({ username, onSignIn, onDismiss }: SignedOutNoticeProps) {
  return (
    <Modal title="You were signed out" onClose={onDismiss}>
      <p>
        Your session as <strong>{username}</strong> has ended, so you are playing as a guest. Sign in again to get
        your games back.
      </p>
      <div className="modal-actions">
        <button className="button button-quiet" type="button" onClick={onDismiss}>
          Not now
        </button>
        <button className="button" type="button" data-autofocus onClick={onSignIn}>
          Sign in
        </button>
      </div>
    </Modal>
  );
}

/** Connects the forms and the notice to the db. At most one dialog is open: a form comes before the notice. */
export function AccountDialogs() {
  const request = useQuery(accountRequest.get(ACCOUNT_ID));
  const session = useQuery(sessionState.get(SESSION_ID));
  const flags = useQuery(sessionFlags.get(SESSION_ID));
  const submit = useOp(submitAccountForm);
  const close = useOp(closeAccountForm);
  const open = useOp(openAccountForm);
  const dismiss = useOp(signedOutNoticeDismissed);

  if (request && request.form !== "signOut") {
    // Keyed by the form, so that moving from one to another starts with empty fields.
    return (
      <AccountForm
        key={request.form}
        request={{ ...request, form: request.form }}
        isAccount={session?.username != null}
        onSubmit={(username, password) => submit({ username, password })}
        onClose={() => close()}
      />
    );
  }
  const signedOutAs = flags?.signedOutAs;
  if (signedOutAs && !request) {
    return (
      <SignedOutNotice
        username={signedOutAs}
        onSignIn={() => {
          open({ form: "signIn", username: signedOutAs });
          dismiss();
        }}
        onDismiss={() => dismiss()}
      />
    );
  }
  return null;
}
