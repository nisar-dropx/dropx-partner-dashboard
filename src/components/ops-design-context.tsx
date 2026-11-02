"use client";

import { createContext, useContext } from "react";

export const OpsDesignContext = createContext(false);
export function useOpsDesign() { return useContext(OpsDesignContext); }
export const OpsReportExportContext = createContext(false);
export function useOpsReportExport() { return useContext(OpsReportExportContext); }
