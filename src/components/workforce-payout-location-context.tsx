"use client";

import { createContext } from "react";

export const WorkforcePayoutLocationContext = createContext<{
  locations: string[];
  onLocationsChange: (locations: string[]) => void;
} | null>(null);
