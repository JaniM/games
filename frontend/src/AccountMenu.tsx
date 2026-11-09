import { useOp, useQuery } from "millpond/react";
import { NameControl } from "./NameControl";
import { OptionsMenu } from "./OptionsMenu";
import { ACCOUNT_ID, accountRequest, openAccountForm, signOut } from "./features/account";
import { PROFILE_ID, profileState } from "./features/profile";
import { SESSION_ID, sessionState } from "./features/session";

export interface AccountMenuViewProps {
  /** The name on the button: an account's username, a guest's name if they have one, else null: the button says "Account" then. */
  name: string | null;
  /** The name an account signs in with, which is also its name in games; null for a guest. */
  username: string | null;
  /** A request is on its way, so there is nothing to start. */
  busy: boolean;
  onCreate: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onDelete: () => void;
}

/**
 * The account in the top right corner: a button with the user's name on it, and under it the
 * name and what they can do about it. A guest can change their name (others see it with a guest
 * indicator) and make an account or sign in. An account's name is its username, which can't be
 * changed, and an account can sign out. Either can delete itself.
 *
 * Everything it shows comes from its props (the name field is the one part with a db of its own),
 * so it can be rendered without one. The forms are not in here: what is in a closed `<details>`
 * isn't shown, so the menu closes as it opens them (see `AccountDialogs`).
 */
export function AccountMenuView({
  name,
  username,
  busy,
  onCreate,
  onSignIn,
  onSignOut,
  onDelete,
}: AccountMenuViewProps) {
  return (
    <OptionsMenu label={name ?? "Account"} clipLabel align="end">
      {(close) => {
        // Closes the menu, then does the thing.
        const then = (action: () => void) => () => {
          close();
          action();
        };
        return (
          <>
            <div className="account-block">
              {username === null ? (
                <>
                  <p className="account-label">Display name</p>
                  <NameControl />
                  <p className="account-note">You are playing as a guest.</p>
                </>
              ) : (
                <>
                  <p className="account-label">Username</p>
                  <p className="account-name">{username}</p>
                </>
              )}
            </div>
            <ul className="menu-list">
              {username === null ? (
                <>
                  <MenuItem disabled={busy} onClick={then(onCreate)}>
                    Create account
                  </MenuItem>
                  <MenuItem disabled={busy} onClick={then(onSignIn)}>
                    Sign in
                  </MenuItem>
                </>
              ) : (
                <MenuItem disabled={busy} onClick={then(onSignOut)}>
                  Sign out
                </MenuItem>
              )}
              <MenuItem disabled={busy} onClick={then(onDelete)}>
                {username === null ? "Delete my data" : "Delete account"}
              </MenuItem>
            </ul>
          </>
        );
      }}
    </OptionsMenu>
  );
}

function MenuItem({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: string }) {
  return (
    <li>
      <button className="menu-item" type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    </li>
  );
}

/** Connects the menu to the session, the profile and the account forms. */
export function AccountMenu() {
  const session = useQuery(sessionState.get(SESSION_ID));
  const profile = useQuery(profileState.get(PROFILE_ID));
  const request = useQuery(accountRequest.get(ACCOUNT_ID));
  const open = useOp(openAccountForm);
  const leave = useOp(signOut);

  // An account's name is its username, which the session knows before the profile has loaded. A
  // guest's name being saved shows already, as in the name field.
  const guestName = profile?.state === "saving" ? profile.pending : (profile?.name ?? null);
  const name = session?.username ?? guestName;
  return (
    <AccountMenuView
      name={name}
      username={session?.username ?? null}
      busy={request?.state === "submitting"}
      onCreate={() => open({ form: "create" })}
      onSignIn={() => open({ form: "signIn" })}
      onSignOut={() => leave()}
      onDelete={() => open({ form: "delete" })}
    />
  );
}
