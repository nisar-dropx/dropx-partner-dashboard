"use client";

import { createContext } from "react";
import type { WorkforceStationReviewSummary } from "@/lib/workforce-payout-station-review";

export const WorkforcePayoutLocationContext = createContext<{
  locations: string[];
  onLocationsChange: (locations: string[]) => void;
  onStationsChange?: (stations: WorkforceStationReviewSummary[]) => void;
} | null>(null);
