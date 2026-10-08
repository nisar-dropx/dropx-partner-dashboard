"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CampaignReport, type Campaign } from "@/components/campaign-report";

export function NotificationHistoryPanel({
  campaignError,
  campaigns
}: {
  campaignError: string | null;
  campaigns: Campaign[];
}) {
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();
  const refreshedOnOpen = useRef(false);

  function refreshHistory() {
    startRefresh(() => router.refresh());
  }

  useEffect(() => {
    if (refreshedOnOpen.current) return;
    refreshedOnOpen.current = true;
    refreshHistory();
  }, []);

  return (
    <CampaignReport
      campaignError={campaignError}
      campaigns={campaigns}
      compactRecipients
      emptyMessage="No notification campaigns found for this period."
      isRefreshing={isRefreshing}
      onRefresh={refreshHistory}
      recipientIdentifierLabel="User ID"
      showChannel
      subtitle="Track WhatsApp campaigns and grouped DropX One payout notifications in one report."
      title="Notification history"
    />
  );
}
