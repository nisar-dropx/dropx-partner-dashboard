// ---------------------------------------------------------------------------
// Cloudflare bindings
// ---------------------------------------------------------------------------
export interface Env {
  /**
   * DropX Dashboard DB (company project): shared workforce_sessions, cloak_sessions,
   * and the loss_report_* tables the Ops pages read — everything lives here.
   */
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ADMIN_API_KEY: string;
  BROWSER?: Fetcher;

  // Cloak (cloak.tech.amazon.dev) — NL loss
  CLOAK_BASE_URL?: string;
  CLOAK_EMAIL?: string;
  CLOAK_PASSWORD?: string;
  CLOAK_COUNTRY?: string;
  CLOAK_PARTNER_SHORTCODE?: string;
  CLOAK_CASE_WITH?: string;
  /** Cognito app client + region behind Cloak's hosted login (token refresh). */
  CLOAK_COGNITO_CLIENT_ID?: string;
  CLOAK_COGNITO_REGION?: string;

  // logistics.amazon.in — SLP loss via the SHARED workforce session
  WORKFORCE_BASE_URL?: string;
  WORKFORCE_COMPANY_ID?: string;
  WORKFORCE_PORTAL_EMAIL?: string;
  WORKFORCE_PORTAL_PASSWORD?: string;
  WORKFORCE_DSP?: string;
  /** Comma list of stations whose weekly supp catalog is scanned (default KOZA). */
  SLP_CATALOG_STATIONS?: string;
  /** How many ISO weeks back to look for the latest Initial / Final file. */
  SLP_LOOKBACK_WEEKS?: string;
  /** Password for Amazon EDSP zip Excel files. */
  AMAZON_EXCEL_OPEN_PASSWORD?: string;
}

// ---------------------------------------------------------------------------
// Workforce (shared with Report-auto-worker / cash-recon)
// ---------------------------------------------------------------------------
export interface WorkforceAuthContext {
  cookie: string;
}

export interface WorkforceAssociate {
  transporterId: string;
  fullName: string;
  providerId: string | null;
  roles: string | null;
  qualifications: string | null;
  operationalStatus: string | null;
  personalPhoneNumber: string | null;
  workPhoneNumber: string | null;
  emailAddress: string | null;
  driverLicenseExpirationDate: string | null;
  photoUrl: string | null;
}

export interface StoredWorkforceSession {
  id: string;
  cookie: string;
  uploadedBy: string;
  uploadedAt: string;
  status: 'active' | 'expired';
  expiredAt: string | null;
  accountKey: string;
}

// ---------------------------------------------------------------------------
// Cloak
// ---------------------------------------------------------------------------
export interface CloakAuthContext {
  /** Full cookie header: Cognito access/id/refresh tokens + csrf_token. */
  cookie: string;
}

export interface StoredCloakSession extends StoredWorkforceSession {}

// ---------------------------------------------------------------------------
// Parsed loss rows (shared by NL + SLP)
// ---------------------------------------------------------------------------
export interface ParsedLossRow {
  stationCode: string | null;
  amount: number | null;
  reference: string | null;
  raw: Record<string, string>;
}

export interface ParsedLossTable {
  headers: string[];
  stationColumn: string | null;
  amountColumn: string | null;
  referenceColumn: string | null;
  rows: ParsedLossRow[];
}
