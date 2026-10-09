/** Optional, publisher-controlled copy rules. No campaign, date or role is hardcoded here. */
export type AnnouncementContext = {
  workspace: string;
  designationCode: string | null;
  locationModelCode: string | null;
  businessLine: string | null;
};

type CopyRule = { designationCodes?: string[]; locationModelCodes?: string[]; businessLines?: string[]; body?: string };
type AudienceCopy = { version: 1; fallbackBody: string; rules: CopyRule[] };
export type PersonalizableNotice = { body: string; data?: unknown };

const key = (value: unknown) => typeof value === "string" ? value.trim().toUpperCase() : "";
const includes = (values: unknown, value: unknown) => Boolean(key(value)) && Array.isArray(values) && values.some(item => key(item) === key(value));

export function audienceCopy(data: unknown): AudienceCopy | null {
  if (!data || typeof data !== "object") return null;
  const copy = (data as { audienceCopy?: AudienceCopy }).audienceCopy;
  return copy?.version === 1 && typeof copy.fallbackBody === "string" && copy.fallbackBody.trim()
    && Array.isArray(copy.rules) ? copy : null;
}

export function personalizeNotice<T extends PersonalizableNotice>(notice: T, context: AnnouncementContext): T {
  const copy = audienceCopy(notice.data);
  if (!copy || context.workspace !== "people") return notice;
  const rule = copy.rules.find(rule => rule && includes(rule.designationCodes, context.designationCode) && (
    // A concrete station model takes precedence over broad legacy values such as "Other".
    context.locationModelCode ? includes(rule.locationModelCodes, context.locationModelCode)
      : includes(rule.businessLines, context.businessLine)
  ) && typeof rule.body === "string" && rule.body.trim());
  return { ...notice, body: rule?.body || copy.fallbackBody };
}
