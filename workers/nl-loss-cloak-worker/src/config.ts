/** Must match Report-auto-worker so the workforce session row is shared. */
export const DEFAULT_PORTAL_ACCOUNT = 'default';

export const DEFAULT_WORKFORCE_BASE_URL = 'https://logistics.amazon.in';
export const DEFAULT_WORKFORCE_COMPANY_ID = 'b63603e9-36e2-4656-9b87-c421489a64a9';

export const WORKFORCE_DSP = 'DROP';
export const WORKFORCE_SUPP_DATASET = 'dsp_station_weekly_supp_reports';

export const WORKFORCE_RESOURCES = {
  fetchDSPAssociates: '/workforce/api/v1/fetchDSPAssociates',
  performanceGetData: '/performance/api/v1/getData',
} as const;

export function workforceBaseUrl(env: { WORKFORCE_BASE_URL?: string }): string {
  return (env.WORKFORCE_BASE_URL ?? DEFAULT_WORKFORCE_BASE_URL).replace(/\/$/, '');
}

export function workforceCompanyId(env: { WORKFORCE_COMPANY_ID?: string }): string {
  return (env.WORKFORCE_COMPANY_ID ?? DEFAULT_WORKFORCE_COMPANY_ID).trim();
}

// ---------------------------------------------------------------------------
// Cloak
// ---------------------------------------------------------------------------
export const DEFAULT_CLOAK_BASE_URL = 'https://cloak.tech.amazon.dev';
// From the Cognito token issuer (us-east-1_4wamV1qyS) and cookie prefix.
export const DEFAULT_CLOAK_COGNITO_CLIENT_ID = '244vsm6r9jvqeb0hm760on5qqr';
export const DEFAULT_CLOAK_COGNITO_REGION = 'us-east-1';

export const CLOAK_RESOURCES = {
  bulkDownload: '/api/v1/bulkDownload',
} as const;

export function cloakBaseUrl(env: { CLOAK_BASE_URL?: string }): string {
  return (env.CLOAK_BASE_URL ?? DEFAULT_CLOAK_BASE_URL).replace(/\/$/, '');
}

export function cloakCognitoClientId(env: { CLOAK_COGNITO_CLIENT_ID?: string }): string {
  return (env.CLOAK_COGNITO_CLIENT_ID ?? DEFAULT_CLOAK_COGNITO_CLIENT_ID).trim();
}

export function cloakCognitoRegion(env: { CLOAK_COGNITO_REGION?: string }): string {
  return (env.CLOAK_COGNITO_REGION ?? DEFAULT_CLOAK_COGNITO_REGION).trim();
}

export function cloakBulkDownloadBody(env: {
  CLOAK_EMAIL?: string;
  CLOAK_COUNTRY?: string;
  CLOAK_PARTNER_SHORTCODE?: string;
  CLOAK_CASE_WITH?: string;
}) {
  return {
    page: 1,
    country: (env.CLOAK_COUNTRY ?? 'IN').trim(),
    partner_shortcode: (env.CLOAK_PARTNER_SHORTCODE ?? 'DROP').trim(),
    case_with: (env.CLOAK_CASE_WITH ?? 'eDSP').trim(),
    userEmail: (env.CLOAK_EMAIL ?? '').trim(),
    dataSource: 'live',
  };
}

// ---------------------------------------------------------------------------
// SLP recovery files (Performance → supplementary reports catalog)
// ---------------------------------------------------------------------------
export type SlpKind = 'initial' | 'final';

export const SLP_FILE_MATCHERS: Record<SlpKind, RegExp> = {
  initial: /SLP\s+Initial\s+Recovery\s+File/i,
  final: /SLP\s+Final\s+Recovery\s+File/i,
};

export function slpCatalogStations(env: { SLP_CATALOG_STATIONS?: string }): string[] {
  const list = String(env.SLP_CATALOG_STATIONS ?? 'KOZA')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : ['KOZA'];
}

export function slpLookbackWeeks(env: { SLP_LOOKBACK_WEEKS?: string }): number {
  const n = Number(env.SLP_LOOKBACK_WEEKS ?? 12);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 26) : 12;
}
