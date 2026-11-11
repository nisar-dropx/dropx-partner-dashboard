export type WorkforcePayoutAudience = "workforce" | "helpers";

export type WorkforceStationReleaseState = {
  stationId: string;
  worksheetHash: string;
  rowCount: number;
  amountPaise: number;
  releasedAt: string;
  releasedBy: string;
  canReopen: boolean;
};

export type WorkforceStationFinanceRequest = {
  id: string;
  stationId: string;
  status: "submitted" | "approved" | "returned";
  worksheetHash: string;
  rowCount: number;
  amountPaise: number;
  version: number;
  submittedBy: string;
  submittedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string;
  changed: boolean;
};
