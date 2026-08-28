"use client";

import { BriefcaseBusiness, ChevronRight, IndianRupee, UserRound } from "lucide-react";
import type { AppAccount } from "./connect-profile-app";

export function ConnectWorkforceWorkspace({
  account,
  onAdvances,
  onProfile
}: {
  account: AppAccount;
  onAdvances: () => void;
  onProfile: () => void;
}) {
  const firstName = (account.name || account.reference || "there").trim().split(/\s+/)[0];

  return <section className="dx-workforce-workspace">
    <header>
      <span><BriefcaseBusiness /></span>
      <div>
        <small>Workforce workspace</small>
        <h1>Welcome, {firstName}</h1>
        <p>{account.role || "Workforce"} · {account.companyName}</p>
      </div>
    </header>

    <section className="dx-workforce-shared-services" aria-label="Shared services">
      <div className="dx-workforce-section-heading">
        <small>Shared services</small>
        <h2>Your essentials</h2>
        <p>Profile and advance requests are shared with DropX One. Other People tools stay inside the People workspace.</p>
      </div>

      <div>
        <button onClick={onProfile}>
          <i className="profile"><UserRound /></i>
          <span><strong>My profile</strong><small>Personal, bank and identity details</small></span>
          <ChevronRight />
        </button>
        <button onClick={onAdvances}>
          <i className="advance"><IndianRupee /></i>
          <span><strong>Advances</strong><small>Request and track payment advances</small></span>
          <ChevronRight />
        </button>
      </div>
    </section>
  </section>;
}
