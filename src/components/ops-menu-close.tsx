"use client";
import { X } from "lucide-react";
import { useOpsDesign } from "@/components/ops-design-context";

export function OpsMenuClose() {
  return useOpsDesign() ? <button type="button" className="ops-mobile-close" data-close-ops-menu aria-label="Close menu"><span>OpsPulse menu</span><X size={20} /></button> : null;
}
