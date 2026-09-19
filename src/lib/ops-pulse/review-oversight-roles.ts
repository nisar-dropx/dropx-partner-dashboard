import "server-only";
import { cache } from "react";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type ReviewOversightTier = "full" | "override";

export type ReviewOversightRole = {
  id: string;
  label: string;
  tier: ReviewOversightTier;
  matchText: string;
  isActive: boolean;
  displayOrder: number;
};

/** Word-boundary, case-insensitive match — same shape as review-policy.ts's reviewRole(). */
function matchesRole(candidate: string, matchText: string) {
  const normalized = ` ${candidate.toUpperCase().replace(/[^A-Z0-9]+/g, " ")} `;
  const needle = matchText.trim().toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  if (!needle) return false;
  return normalized.includes(` ${needle} `);
}

/** All configured oversight roles for a company, active first — used by Master and by the matcher below. */
export const loadReviewOversightRoles = cache(async (companyId: string): Promise<{ rows: ReviewOversightRole[]; error: string | null }> => {
  if (!supabaseAdmin) return { rows: [], error: "Review oversight roles are unavailable." };
  const result = await supabaseAdmin.from("ops_performance_review_oversight_roles")
    .select("id,label,tier,match_text,is_active,display_order")
    .eq("company_id", companyId)
    .order("display_order");
  if (result.error) return { rows: [], error: result.error.message };
  return {
    rows: (result.data ?? []).map((row) => ({
      id: row.id,
      label: row.label,
      tier: row.tier as ReviewOversightTier,
      matchText: row.match_text,
      isActive: row.is_active,
      displayOrder: row.display_order
    })),
    error: null
  };
});

/**
 * Does any of this reviewer's designation/role labels match a configured oversight role at
 * or above the given tier? 'full' roles also count for an 'override' check — full oversight
 * is a superset of override rights.
 */
export function matchesOversightTier(roles: ReviewOversightRole[], labels: string[], tier: ReviewOversightTier) {
  return roles.some((role) => {
    if (!role.isActive) return false;
    if (tier === "override" && role.tier !== "override" && role.tier !== "full") return false;
    if (tier === "full" && role.tier !== "full") return false;
    return labels.some((label) => matchesRole(label, role.matchText));
  });
}

function normalizedMatchText(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export async function addReviewOversightRole(companyId: string, userId: string, input: { label: string; tier: ReviewOversightTier; matchText: string }) {
  if (!supabaseAdmin) return "Review oversight roles are unavailable.";
  const label = input.label.trim();
  const matchText = normalizedMatchText(input.matchText);
  if (!label) return "Enter a name for this oversight role.";
  if (!matchText) return "Enter the designation or role text to match.";
  if (!["full", "override"].includes(input.tier)) return "Choose a valid oversight tier.";
  const result = await supabaseAdmin.from("ops_performance_review_oversight_roles").insert({
    company_id: companyId, label, tier: input.tier, match_text: matchText,
    created_by: userId, updated_by: userId
  });
  if (result.error) return /duplicate key/i.test(result.error.message) ? "This designation/role text is already in the oversight list." : result.error.message;
  return null;
}

export async function updateReviewOversightRole(companyId: string, userId: string, id: string, input: { label: string; tier: ReviewOversightTier; isActive: boolean }) {
  if (!supabaseAdmin) return "Review oversight roles are unavailable.";
  const label = input.label.trim();
  if (!label) return "Enter a name for this oversight role.";
  if (!["full", "override"].includes(input.tier)) return "Choose a valid oversight tier.";
  const result = await supabaseAdmin.from("ops_performance_review_oversight_roles")
    .update({ label, tier: input.tier, is_active: input.isActive, updated_by: userId, updated_at: new Date().toISOString() })
    .eq("company_id", companyId).eq("id", id);
  return result.error?.message ?? null;
}

export async function removeReviewOversightRole(companyId: string, id: string) {
  if (!supabaseAdmin) return "Review oversight roles are unavailable.";
  const result = await supabaseAdmin.from("ops_performance_review_oversight_roles").delete().eq("company_id", companyId).eq("id", id);
  return result.error?.message ?? null;
}
