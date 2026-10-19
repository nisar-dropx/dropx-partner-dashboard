"use client";

import { createContext, useContext } from "react";

export const OpsDesignContext = createContext(false);
export function useOpsDesign() { return useContext(OpsDesignContext); }
