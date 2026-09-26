"use client";

import type { AppAccount } from "./connect-profile-app";
import { ConnectWorkforceJoining } from "./connect-workforce-joining";

export function ConnectActivationStatus({ account }: { account: AppAccount }) {
  return <section className="dx-main dx-activation-only">
    <header className="dx-page-intro"><small>DropX One access</small><h1>Complete your work setup</h1><p>Your work menus will open after the required partner account and assignment are confirmed.</p></header>
    <ConnectWorkforceJoining account={account} activationOnly />
  </section>;
}
