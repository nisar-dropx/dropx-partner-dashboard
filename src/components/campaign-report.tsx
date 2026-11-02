"use client";
import { ReportTable } from "@/components/report-table";


import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { formatDashboardDateTime } from "@/lib/date-format";

export type CampaignRecipient = {
  id: string;
  row_no: number;
  recipient_name: string | null;
  recipient_mobile: string;
  country_code?: string | null;
  status: string;
  provider_message_id: string | null;
  error_message: string | null;
  sent_at: string | null;
  updated_at?: string | null;
};

export type Campaign = {
  id: string;
  campaign_code: string;
  channel?: string | null;
  whatsapp_profile_id: string | null;
  whatsapp_profile_name: string | null;
  created_at: string;
  total_count: number;
  sent_count: number;
  failed_count: number;
  pending_count: number;
  status: string;
  whatsapp_campaign_recipients?: CampaignRecipient[];
};

const campaignPageSize = 10;

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultCampaignStartDate() {
  const date = new Date();
  date.setDate(date.getDate() - 6);
  return toDateInputValue(date);
}

function getCampaignStatusCounts(campaign: Campaign) {
  const counts = {
    all: campaign.total_count,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0
  };
  (campaign.whatsapp_campaign_recipients ?? []).forEach((recipient) => {
    const status = recipient.status.toLowerCase();
    if (status === "sent") counts.sent += 1;
    if (status === "delivered") counts.delivered += 1;
    if (status === "read") counts.read += 1;
    if (status === "failed") counts.failed += 1;
  });
  return counts;
}

function notificationStatusClass(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "sent") return "whatsapp-status-sent";
  if (normalized === "delivered") return "whatsapp-status-delivered";
  if (normalized === "read") return "whatsapp-status-read";
  if (normalized === "failed") return "whatsapp-status-failed";
  return normalized === "completed" ? "good" : "warn";
}

function formatUserId(recipient: CampaignRecipient, channel?: string | null) {
  if (String(channel ?? "").toLowerCase() !== "whatsapp") return recipient.recipient_mobile;
  const countryCode = String(recipient.country_code ?? "").replace(/\D/g, "") || "91";
  const mobile = String(recipient.recipient_mobile ?? "").replace(/\D/g, "");
  const withoutCountry = mobile.startsWith(countryCode) && mobile.length > countryCode.length + 5
    ? mobile.slice(countryCode.length)
    : mobile;
  return `+${countryCode}-${withoutCountry || mobile}`;
}

function formatUpdatedAt(value?: string | null) {
  return formatDashboardDateTime(value);
}

export function CampaignReport({
  campaignError,
  campaigns,
  compactRecipients = true,
  emptyMessage = "No campaigns found for this period.",
  isRefreshing,
  onRefresh,
  recipientIdentifierLabel = "User ID",
  showChannel = false,
  subtitle = "Track campaigns and open any campaign for number-wise results.",
  title = "Campaign report"
}: {
  campaignError: string | null;
  campaigns: Campaign[];
  compactRecipients?: boolean;
  emptyMessage?: string;
  isRefreshing: boolean;
  onRefresh: () => void;
  recipientIdentifierLabel?: string;
  showChannel?: boolean;
  subtitle?: string;
  title?: string;
}) {
  const [fromDate, setFromDate] = useState(defaultCampaignStartDate);
  const [toDate, setToDate] = useState(() => toDateInputValue(new Date()));
  const [campaignPage, setCampaignPage] = useState(1);
  const filteredCampaigns = useMemo(() => {
    const start = fromDate ? new Date(`${fromDate}T00:00:00`) : null;
    const end = toDate ? new Date(`${toDate}T23:59:59.999`) : null;
    return campaigns.filter((campaign) => {
      const createdAt = new Date(campaign.created_at);
      if (start && createdAt < start) return false;
      if (end && createdAt > end) return false;
      return true;
    });
  }, [campaigns, fromDate, toDate]);
  const campaignTotalPages = Math.max(1, Math.ceil(filteredCampaigns.length / campaignPageSize));
  const currentCampaignPage = Math.min(campaignPage, campaignTotalPages);
  const visibleCampaigns = filteredCampaigns.slice((currentCampaignPage - 1) * campaignPageSize, currentCampaignPage * campaignPageSize);
  const headerColumns = showChannel ? 10 : 9;

  useEffect(() => {
    setCampaignPage(1);
  }, [fromDate, toDate]);

  useEffect(() => {
    if (campaignPage > campaignTotalPages) setCampaignPage(campaignTotalPages);
  }, [campaignPage, campaignTotalPages]);

  return (
    <section className={`panel whatsapp-campaign-report ${showChannel ? "with-channel" : ""}`}>
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          <p className="subtle">{subtitle}</p>
        </div>
        <div className="campaign-history-tools">
          <label>From
            <input className="field" onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} />
          </label>
          <label>To
            <input className="field" onChange={(event) => setToDate(event.target.value)} type="date" value={toDate} />
          </label>
          <button aria-label="Refresh campaign history" className={`icon-button history-refresh-button ${isRefreshing ? "loading" : ""}`} onClick={onRefresh} title="Refresh" type="button">
            <RefreshCw size={18} />
          </button>
        </div>
      </div>
      {campaignError ? (
        <div className="panel-body">
          <div className="message-panel error inline-message">
            <strong>Campaign database setup needed</strong>
            <p className="subtle">{campaignError}</p>
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <ReportTable>
            {showChannel ? (
              <colgroup>
                <col style={{ width: "15%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "13%" }} />
                <col style={{ width: "15%" }} />
                <col style={{ width: "6%" }} />
                <col style={{ width: "7%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "7%" }} />
                <col style={{ width: "7%" }} />
                <col style={{ width: "10%" }} />
              </colgroup>
            ) : (
              <colgroup>
                <col style={{ width: "18%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "17%" }} />
                <col style={{ width: "7%" }} />
                <col style={{ width: "8%" }} />
                <col style={{ width: "11%" }} />
                <col style={{ width: "8%" }} />
                <col style={{ width: "7%" }} />
                <col style={{ width: "8%" }} />
              </colgroup>
            )}
            <thead>
              <tr>
                <th>Campaign ID</th>
                {showChannel ? <th>Channel</th> : null}
                <th>Profile</th>
                <th>Created on</th>
                <th>All</th>
                <th>Sent</th>
                <th>Delivered</th>
                <th>Read</th>
                <th>Failed</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleCampaigns.length ? visibleCampaigns.map((campaign) => {
                const counts = getCampaignStatusCounts(campaign);
                return (
                  <tr className="campaign-row" key={campaign.id}>
                    <td colSpan={headerColumns}>
                      <details>
                        <summary>
                          <span className="campaign-code">{campaign.campaign_code}</span>
                          {showChannel ? <span>{campaign.channel || "WhatsApp"}</span> : null}
                          <span>{campaign.whatsapp_profile_name || "-"}</span>
                          <span>{formatDashboardDateTime(campaign.created_at)}</span>
                          <span>{counts.all}</span>
                          <span className="muted-count">{counts.sent}</span>
                          <span className="good-text">{counts.delivered}</span>
                          <span className="read-text">{counts.read}</span>
                          <span className={counts.failed ? "danger-text" : ""}>{counts.failed}</span>
                          <span className={`status-pill ${notificationStatusClass(campaign.status)}`}>{campaign.status}</span>
                        </summary>
                        <div className={`campaign-recipient-table ${compactRecipients ? "compact-recipient-table" : ""}`}>
                          <ReportTable>
                            <colgroup>
                              <col style={{ width: "44px" }} />
                              <col style={{ width: "170px" }} />
                              <col style={{ width: "150px" }} />
                              <col style={{ width: "120px" }} />
                              <col style={{ width: "170px" }} />
                              <col />
                            </colgroup>
                            <thead>
                              <tr>
                                <th>#</th>
                                <th>Name</th>
                                <th>{recipientIdentifierLabel}</th>
                                <th>Status</th>
                                <th>Updated on</th>
                                <th>Error</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(campaign.whatsapp_campaign_recipients ?? []).length ? (campaign.whatsapp_campaign_recipients ?? []).map((recipient) => (
                                <tr key={recipient.id}>
                                  <td>{recipient.row_no}</td>
                                  <td>{recipient.recipient_name || "-"}</td>
                                  <td>{formatUserId(recipient, campaign.channel || "WhatsApp")}</td>
                                  <td><span className={`status-pill ${notificationStatusClass(recipient.status)}`}>{recipient.status}</span></td>
                                  <td>{formatUpdatedAt(recipient.updated_at ?? recipient.sent_at)}</td>
                                  <td>{recipient.error_message || "-"}</td>
                                </tr>
                              )) : <tr><td className="empty-cell" colSpan={6}>No recipient rows found.</td></tr>}
                            </tbody>
                          </ReportTable>
                        </div>
                      </details>
                    </td>
                  </tr>
                );
              }) : <tr><td className="empty-cell" colSpan={headerColumns}>{emptyMessage}</td></tr>}
            </tbody>
          </ReportTable>
          <div className="pagination-row campaign-pagination">
            <span>{filteredCampaigns.length} campaigns</span>
            <div className="pager">
              <button className={`pager-button ${currentCampaignPage <= 1 ? "disabled" : ""}`} onClick={() => setCampaignPage((current) => Math.max(1, current - 1))} type="button">Prev</button>
              <span>Page {currentCampaignPage} of {campaignTotalPages}</span>
              <button className={`pager-button ${currentCampaignPage >= campaignTotalPages ? "disabled" : ""}`} onClick={() => setCampaignPage((current) => Math.min(campaignTotalPages, current + 1))} type="button">Next</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
