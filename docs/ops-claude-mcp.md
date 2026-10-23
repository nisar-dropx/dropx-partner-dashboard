# Ops Claude remote MCP

Read-only Claude connector for Ops Pulse at `https://ops.dropxlogistics.com/mcp`.
Deployed only on the **dropx-ops-pulse** Vercel project (`dropx1` scope). Never enable this on the partner dashboard project.

## Part A — Office Wi‑Fi DNS (do this once at the registrar)

Vercel Domains for `ops.dropxlogistics.com` recommends replacing the legacy shared CNAME:

| Record | Current (legacy) | Recommended |
|---|---|---|
| `ops` CNAME | `cname.vercel-dns.com` | `7a10f280f74abb8a.vercel-dns-016.com` |

Office routers often resolve project-specific `*.vercel-dns-0xx.com` names (dashboard / people / connect) but fail to chase the legacy shared target. That shows up as Ops “reconnect / offline” on office Wi‑Fi while mobile hotspot still works.

**Fix for all colleagues (no laptop DNS changes):**

1. At the DNS provider for `dropxlogistics.com`, set CNAME `ops` → `7a10f280f74abb8a.vercel-dns-016.com` (exactly as Vercel recommends; trailing dot optional depending on the provider).
2. Keep the domain bound to **`dropx-ops-pulse` only**. Do not also attach it to `ops-source` or the partner dashboard project.
3. Wait for propagation, then on office Wi‑Fi run `nslookup ops.dropxlogistics.com` and confirm A records resolve.

**Do not delete** `ops.dropxlogistics.com` from Vercel. Codex / MCP domain checks can surface the “DNS Change Recommended” banner; that is not a reason to remove the production domain.

## Part B — MCP connector

### Endpoints

| URL | Role |
|---|---|
| `https://ops.dropxlogistics.com/mcp` | MCP JSON-RPC (Bearer only; no session cookie) |
| `https://ops.dropxlogistics.com/.well-known/oauth-protected-resource` | RFC 9728 resource metadata |
| `https://ops.dropxlogistics.com/.well-known/oauth-authorization-server` | RFC 8414 AS metadata (PKCE S256, DCR, CIMD) |
| `https://ops.dropxlogistics.com/api/mcp/oauth/register` | Dynamic client registration (public clients) |
| `https://ops.dropxlogistics.com/api/mcp/oauth/authorize` | Authorization + consent hand-off |
| `https://ops.dropxlogistics.com/api/mcp/oauth/token` | Code exchange / refresh |
| `https://ops.dropxlogistics.com/mcp/consent` | User consent UI (DropX Google session) |

Unauthenticated `GET`/`POST` to `/mcp` returns **401** with
`WWW-Authenticate: Bearer … resource_metadata="https://ops.dropxlogistics.com/.well-known/oauth-protected-resource"`.

### Auth model

- OAuth 2.1 authorization code + **PKCE S256**.
- User signs in with the existing Ops / Supabase Google session; Claude never receives browser cookies.
- Claude receives opaque bearer access tokens. Only **SHA-256 hashes** of codes/tokens are stored (`mcp_oauth_*` tables).
- Authorization codes expire in ~5 minutes and are single-use.
- After token validation the server loads the DropX user → Ops product membership → `company_id` + station scope (`location_scope_ids` / all-locations) and requires `ops_pulse` access.

### Tools (read-only)

- `ops_list_permitted_stations`
- `ops_capacity_snapshot` (needs `capacity`)
- `ops_station_delivery_summary`
- `ops_cod_summary` (needs `cod`)
- `ops_loss_case_summary` (needs `ops_losses`)

Write-like tool names and MCP write methods are rejected.

### Database migration

File: `supabase/migrations/20261023120000_ops_mcp_oauth.sql`

Apply to the **shared** Supabase project one file at a time (see `docs/team-ops-payroll-workflows.md`):

```bash
supabase db query --linked -f supabase/migrations/20261023120000_ops_mcp_oauth.sql
supabase migration repair --status applied 20261023120000 --linked
```

### Environment

No Anthropic client secret is stored in the repo (public clients + DCR/CIMD).

Optional / existing server secrets on **dropx-ops-pulse** only:

- Standard Supabase URL + service role (already required for Ops).
- No extra `MCP_*` env is required for the hashed opaque-token design shipped here.

### Deploy (Ops only)

```bash
pnpm exec vercel deploy --prod --scope dropx1 --project dropx-ops-pulse
```

Do **not** deploy this surface via the partner-dashboard / `dashboard.dropxlogistics.com` project.

### Verify before Claude setup

1. Migration applied.
2. DNS CNAME updated (Part A).
3. Unit tests: `node --experimental-strip-types --test src/lib/mcp/*.test.mjs`
4. Deploy to `dropx-ops-pulse`.
5. Curl checks:

```bash
curl -sS https://ops.dropxlogistics.com/.well-known/oauth-authorization-server
curl -sS https://ops.dropxlogistics.com/.well-known/oauth-protected-resource
curl -si https://ops.dropxlogistics.com/mcp
# expect HTTP/1.1 401 and WWW-Authenticate with resource_metadata
```

### Claude connector settings

1. Connector name: **Ops** (or DropX Ops).
2. MCP URL: `https://ops.dropxlogistics.com/mcp`
3. Sign in now — complete DropX Google login + consent (“Allow Claude read-only Ops access”).
4. Use Claude’s published / connector identity (DCR or CIMD); no Anthropic-held secret is configured in this repo.

### Explicit non-goals

- No MCP on `dashboard.dropxlogistics.com`.
- No deleting `ops.dropxlogistics.com` from Vercel.
- No write tools; no session-cookie passthrough to Claude.
