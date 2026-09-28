"use client";

import type { AppAccount } from "./connect-profile-app";
import { ConnectWorkforceJoining } from "./connect-workforce-joining";

export function ConnectActivationStatus({ account }: { account: AppAccount }) {
  return <section className="dx-main dx-activation-only">
    <header className="dx-page-intro"><small>DropX One access</small><h1>Your ID creation status</h1><p>Follow your pending step below. Your work menus open after your team confirms the provider ID mapping.</p></header>
    <ConnectWorkforceJoining account={account} activationOnly />
  </section>;
}
