import "server-only";

import { getVercelOidcToken } from "@vercel/oidc";
import { JWT } from "google-auth-library";

const DIRECTORY_BASE_URL = "https://admin.googleapis.com/admin/directory/v1";

const WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user",
  "https://www.googleapis.com/auth/admin.directory.user.security",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.member"
];

export type WorkspaceConnectionSettings = {
  customerId: string | null;
  delegatedAdminEmail: string;
  primaryDomain: string;
};

export type GoogleDirectoryUser = {
  id: string;
  primaryEmail: string;
  name?: {
    fullName?: string;
    givenName?: string;
    familyName?: string;
  };
  orgUnitPath?: string;
  suspended?: boolean;
  archived?: boolean;
  isAdmin?: boolean;
  etag?: string;
  creationTime?: string;
  lastLoginTime?: string;
};

type WorkspaceServiceAccount = {
  client_email: string;
  private_key: string;
};

type WorkspaceFederation = {
  projectNumber: string;
  poolId: string;
  providerId: string;
  serviceAccountEmail: string;
};

function normalizePrivateKey(value: string) {
  return value.replace(/\\n/g, "\n").trim();
}

function serviceAccountFromEnvironment(): WorkspaceServiceAccount | null {
  const rawJson = process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) {
    try {
      const decoded = rawJson.startsWith("{")
        ? rawJson
        : Buffer.from(rawJson, "base64").toString("utf8");
      const parsed = JSON.parse(decoded) as Partial<WorkspaceServiceAccount>;
      if (parsed.client_email && parsed.private_key) {
        return {
          client_email: parsed.client_email.trim(),
          private_key: normalizePrivateKey(parsed.private_key)
        };
      }
    } catch {
      return null;
    }
  }

  const clientEmail = process.env.GOOGLE_WORKSPACE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.GOOGLE_WORKSPACE_PRIVATE_KEY?.trim();
  if (!clientEmail || !privateKey) return null;
  return { client_email: clientEmail, private_key: normalizePrivateKey(privateKey) };
}

export function workspaceCredentialsConfigured() {
  return Boolean(serviceAccountFromEnvironment() || federationFromEnvironment());
}

function federationFromEnvironment(): WorkspaceFederation | null {
  const projectNumber = process.env.GCP_PROJECT_NUMBER?.trim();
  const poolId = process.env.GCP_WORKLOAD_IDENTITY_POOL_ID?.trim();
  const providerId = process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID?.trim();
  const serviceAccountEmail = process.env.GCP_SERVICE_ACCOUNT_EMAIL?.trim();
  if (!projectNumber || !poolId || !providerId || !serviceAccountEmail) return null;
  return { projectNumber, poolId, providerId, serviceAccountEmail };
}

async function jsonResponse<T>(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({})) as T & { error?: { message?: string }; error_description?: string };
  if (!response.ok) throw new Error(body.error?.message ?? body.error_description ?? fallback);
  return body;
}

async function federatedWorkspaceAccessToken(federation: WorkspaceFederation, delegatedAdminEmail: string) {
  const oidcToken = await getVercelOidcToken();
  const audience = `//iam.googleapis.com/projects/${federation.projectNumber}/locations/global/workloadIdentityPools/${federation.poolId}/providers/${federation.providerId}`;
  const stsBody = new URLSearchParams({
    audience,
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: "https://www.googleapis.com/auth/cloud-platform",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    subject_token: oidcToken
  });
  const sts = await jsonResponse<{ access_token: string }>(await fetch("https://sts.googleapis.com/v1/token", {
    method: "POST",
    body: stsBody,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    cache: "no-store"
  }), "Google Security Token Service rejected the Vercel workload identity.");

  const issuedAt = Math.floor(Date.now() / 1000);
  const claim = JSON.stringify({
    iss: federation.serviceAccountEmail,
    sub: delegatedAdminEmail,
    scope: WORKSPACE_SCOPES.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3300
  });
  const signUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(federation.serviceAccountEmail)}:signJwt`;
  const signed = await jsonResponse<{ signedJwt: string }>(await fetch(signUrl, {
    method: "POST",
    body: JSON.stringify({ payload: claim }),
    headers: { authorization: `Bearer ${sts.access_token}`, "content-type": "application/json" },
    cache: "no-store"
  }), "Google IAM could not sign the delegated Workspace assertion.");
  const tokenBody = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: signed.signedJwt
  });
  return jsonResponse<{ access_token: string; expires_in: number }>(await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: tokenBody,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    cache: "no-store"
  }), "Google Workspace rejected the delegated service assertion.");
}

export class GoogleWorkspaceApiError extends Error {
  status: number;
  reason: string | null;

  constructor(message: string, status: number, reason: string | null = null) {
    super(message);
    this.name = "GoogleWorkspaceApiError";
    this.status = status;
    this.reason = reason;
  }
}

export class GoogleWorkspaceClient {
  private readonly auth: JWT | null;
  private readonly federation: WorkspaceFederation | null;
  private readonly settings: WorkspaceConnectionSettings;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(settings: WorkspaceConnectionSettings) {
    const serviceAccount = serviceAccountFromEnvironment();
    const federation = federationFromEnvironment();
    if (!serviceAccount && !federation) throw new Error("Google Workspace workload identity is not configured.");
    if (!settings.delegatedAdminEmail) {
      throw new Error("A delegated Google Workspace administrator is not configured.");
    }

    this.settings = settings;
    this.federation = federation;
    this.auth = serviceAccount ? new JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: WORKSPACE_SCOPES,
      subject: settings.delegatedAdminEmail
    }) : null;
  }

  private async accessToken() {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60000) return this.cachedToken.token;
    if (this.auth) {
      const token = await this.auth.getAccessToken();
      if (!token.token) throw new Error("Google Workspace did not return an access token.");
      return token.token;
    }
    if (!this.federation) throw new Error("Google Workspace workload identity is not configured.");
    const token = await federatedWorkspaceAccessToken(this.federation, this.settings.delegatedAdminEmail);
    this.cachedToken = { token: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
    return token.access_token;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.accessToken();

    const response = await fetch(`${DIRECTORY_BASE_URL}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init?.headers ?? {})
      }
    });

    if (response.status === 204) return undefined as T;
    const body = await response.json().catch(() => ({})) as {
      error?: { message?: string; errors?: Array<{ reason?: string }> };
    } & T;
    if (!response.ok) {
      throw new GoogleWorkspaceApiError(
        body.error?.message ?? `Google Workspace request failed with HTTP ${response.status}.`,
        response.status,
        body.error?.errors?.[0]?.reason ?? null
      );
    }
    return body as T;
  }

  async listUsers() {
    const users: GoogleDirectoryUser[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({ maxResults: "500", orderBy: "email", projection: "full" });
      if (this.settings.customerId) params.set("customer", this.settings.customerId);
      else params.set("domain", this.settings.primaryDomain);
      if (pageToken) params.set("pageToken", pageToken);
      const result = await this.request<{ users?: GoogleDirectoryUser[]; nextPageToken?: string }>(`/users?${params}`);
      users.push(...(result.users ?? []));
      pageToken = result.nextPageToken ?? "";
    } while (pageToken);
    return users;
  }

  async getUser(userKey: string) {
    try {
      return await this.request<GoogleDirectoryUser>(`/users/${encodeURIComponent(userKey)}?projection=full`);
    } catch (error) {
      if (error instanceof GoogleWorkspaceApiError && error.status === 404) return null;
      throw error;
    }
  }

  createUser(input: {
    primaryEmail: string;
    givenName: string;
    familyName: string;
    password: string;
    orgUnitPath: string;
  }) {
    return this.request<GoogleDirectoryUser>("/users", {
      method: "POST",
      body: JSON.stringify({
        primaryEmail: input.primaryEmail,
        password: input.password,
        changePasswordAtNextLogin: true,
        orgUnitPath: input.orgUnitPath,
        name: { givenName: input.givenName, familyName: input.familyName }
      })
    });
  }

  patchUser(userKey: string, input: Record<string, unknown>) {
    return this.request<GoogleDirectoryUser>(`/users/${encodeURIComponent(userKey)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  async suspendUser(userKey: string) {
    const user = await this.patchUser(userKey, { suspended: true });
    await this.request<void>(`/users/${encodeURIComponent(userKey)}/signOut`, { method: "POST", body: "{}" });
    return user;
  }

  restoreUser(userKey: string) {
    return this.patchUser(userKey, { suspended: false });
  }

  deleteUser(userKey: string) {
    return this.request<void>(`/users/${encodeURIComponent(userKey)}`, { method: "DELETE" });
  }

  async listUserGroups(userKey: string) {
    const groups: Array<{ id: string; email: string; name?: string }> = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({ userKey, maxResults: "200" });
      if (pageToken) params.set("pageToken", pageToken);
      const result = await this.request<{ groups?: Array<{ id: string; email: string; name?: string }>; nextPageToken?: string }>(`/groups?${params}`);
      groups.push(...(result.groups ?? []));
      pageToken = result.nextPageToken ?? "";
    } while (pageToken);
    return groups;
  }

  addGroupMember(groupKey: string, userKey: string) {
    return this.request(`/groups/${encodeURIComponent(groupKey)}/members`, {
      method: "POST",
      body: JSON.stringify({ email: userKey, role: "MEMBER" })
    });
  }

  async removeGroupMember(groupKey: string, userKey: string) {
    try {
      await this.request<void>(`/groups/${encodeURIComponent(groupKey)}/members/${encodeURIComponent(userKey)}`, { method: "DELETE" });
    } catch (error) {
      if (error instanceof GoogleWorkspaceApiError && error.status === 404) return;
      throw error;
    }
  }
}
