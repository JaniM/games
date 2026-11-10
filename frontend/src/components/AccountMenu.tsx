import { useOp, useQuery } from "millpond/react";
import { NameControl } from "./NameControl";
import { OptionsMenu } from "./OptionsMenu";
import { ThemeControl } from "./ThemeControl";
import { VolumeControl } from "./VolumeControl";
import { ACCOUNT_ID, accountRequest, openAccountForm, signOut } from "../features/account";
import { PROFILE_ID, profileState } from "../features/profile";
import { SESSION_ID, sessionState } from "../features/session";

/**
 * The account in the top right corner: a button with the user's name on it, and under it the
 * name and what they can do about it. A guest can change their name (others see it with a guest
 * indicator) and make an account or sign in. An account's name is its username, which can't be
 * changed, and an account can sign out. Either can delete itself. The list starts with the
 * settings: the volume, on a page with sound (`showSound`, a game's), and the theme, on every page.
 *
 * The forms are not in here: what is in a closed `<details>` isn't shown, so the menu closes as
 * it opens them (see `AccountDialogs`).
 */
export function AccountMenu({ showSound }: { showSound: boolean }) {
  const session = useQuery(sessionState.get(SESSION_ID));
  const profile = useQuery(profileState.get(PROFILE_ID));
  const request = useQuery(accountRequest.get(ACCOUNT_ID));
  const open = useOp(openAccountForm);
  const leave = useOp(signOut);

  // The name an account signs in with, which is also its name in games; null for a guest.
  const username = session?.username ?? null;
  // An account's name is its username, which the session knows before the profile has loaded. A
  // guest's name being saved shows already, as in the name field. Without one the button says "Account".
  const guestName = profile?.state === "saving" ? profile.pending : (profile?.name ?? null);
  const name = username ?? guestName;
  // A request is on its way, so there is nothing to start.
  const busy = request?.state === "submitting";

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
              {showSound && (
                <li className="menu-row">
                  <VolumeControl />
                </li>
              )}
              <li className="menu-row">
                <ThemeControl />
              </li>
              {username === null ? (
                <>
                  <MenuItem disabled={busy} onClick={then(() => open({ form: "create" }))}>
                    Create account
                  </MenuItem>
                  <MenuItem disabled={busy} onClick={then(() => open({ form: "signIn" }))}>
                    Sign in
                  </MenuItem>
                </>
              ) : (
                <MenuItem disabled={busy} onClick={then(() => leave())}>
                  Sign out
                </MenuItem>
              )}
              <MenuItem disabled={busy} onClick={then(() => open({ form: "delete" }))}>
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
