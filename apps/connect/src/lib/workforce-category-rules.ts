import {
  normalizeCategoryProfileFieldRules,
  intersectProfileFieldChannelRules,
  profileFieldRulesForCategory,
  type ProfileFieldChannelRules,
  type ProfileFieldRuleCategory
} from "@/lib/profile-field-rules";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function loadWorkforceCategoryRules(
  companyId: string,
  categoryCode: string,
  fallbackDesignationRules?: unknown,
  fallbackCategory: ProfileFieldRuleCategory = "employees"
): Promise<ProfileFieldChannelRules> {
  if (supabaseAdmin) {
    const result = await supabaseAdmin
      .from("workforce_categories")
      .select("profile_field_rules")
      .eq("company_id", companyId)
      .eq("code", categoryCode)
      .eq("is_active", true)
      .maybeSingle();
    if (!result.error && result.data) {
      const categoryRules = normalizeCategoryProfileFieldRules(result.data.profile_field_rules);
      if (fallbackDesignationRules == null) return categoryRules;
      return intersectProfileFieldChannelRules(
        categoryRules,
        profileFieldRulesForCategory(fallbackDesignationRules, categoryCode, fallbackCategory)
      );
    }
  }
  if (fallbackDesignationRules != null) {
    return {
      dropx_one: { enabled: [], required: [] },
      dashboard: { enabled: [], required: [] }
    };
  }
  return profileFieldRulesForCategory(fallbackDesignationRules, categoryCode, fallbackCategory);
}
