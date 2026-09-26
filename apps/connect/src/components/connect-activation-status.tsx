"use client";

import type { AppAccount } from "./connect-profile-app";
import { ConnectWorkforceJoining } from "./connect-workforce-joining";

export function ConnectActivationStatus({ account }: { account: AppAccount }) {
  return <section className="dx-main dx-activation-only">
    <header className="dx-page-intro"><small>DropX One access</small><h1>Complete your Amazon ID</h1><p>Your work menus will open automatically after the Amazon ID is active.</p></header>
    <ConnectWorkforceJoining account={account} activationOnly />
  </section>;
}
