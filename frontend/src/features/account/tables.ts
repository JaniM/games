import { table } from "millpond";
import { z } from "zod";

/** The singleton key of the one `accountRequest` row. */
export const ACCOUNT_ID = "current";

/**
 * What the user is doing about their account: a form that is open, or a request that is on its
 * way. No row means neither. `state` says where it stands:
 *
 * - `editing`: a form is open (`create`, `signIn` or `delete`) and waiting to be sent. `error`
 *   says why the last try failed, or is null.
 * - `submitting`: what the `submitAccount` effect picks up. The form can't be dismissed
 *   meanwhile, since the request is made whatever the user does next. `password` is what the
 *   form sent. A request that went through deletes the row, and with it the password.
 *
 * `signOut` has no form: its row is `submitting` from the start.
 */
export const accountRequest = table(
  z.object({
    id: z.string(),
    form: z.enum(["create", "signIn", "delete", "signOut"]),
    state: z.enum(["editing", "submitting"]),
    /** The username the form starts with (see `openAccountForm`), then the one it sent. */
    username: z.string(),
    /** Only while `submitting`, and then null again. Kept in memory and nowhere else. */
    password: z.string().nullable(),
    error: z.string().nullable(),
  }),
  { key: "id", indexes: { byState: ["state"] } },
);
