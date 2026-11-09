import { feature } from "millpond";
import { submitAccount } from "./effects";
import {
  accountCreated,
  accountFailed,
  accountLeft,
  accountSignedIn,
  closeAccountForm,
  openAccountForm,
  signOut,
  submitAccountForm,
} from "./ops";
import { accountRequest } from "./tables";

export const account = feature({
  tables: { accountRequest },
  ops: {
    openAccountForm,
    closeAccountForm,
    submitAccountForm,
    signOut,
    accountFailed,
    accountCreated,
    accountSignedIn,
    accountLeft,
  },
  effects: { submitAccount },
});

// Components import definitions by value; they never need the assembled db.
export { closeAccountForm, openAccountForm, signOut, submitAccountForm } from "./ops";
export { ACCOUNT_ID, accountRequest } from "./tables";
