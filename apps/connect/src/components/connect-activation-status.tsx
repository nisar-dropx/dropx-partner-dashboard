"use client";

import type { AppAccount } from "./connect-profile-app";
import { ConnectWorkforceJoining } from "./connect-workforce-joining";

export function ConnectActivationStatus({ account,onRegister }: { account: AppAccount;onRegister:()=>void }) {
  return <section className="dx-main dx-activation-only">
    <header className="dx-page-intro"><small>DropX One · beta onboarding</small><h1>Your work setup</h1><p>Complete registration and follow your Amazon activation from one screen.</p></header>
    <ConnectWorkforceJoining account={account} activationOnly onRegister={onRegister}/>
  </section>;
}
