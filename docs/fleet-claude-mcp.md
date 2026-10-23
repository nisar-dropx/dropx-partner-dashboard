# Fleet Claude remote MCP

Read-only Claude connector for DropX Fleet at `https://fleet.dropxlogistics.com/mcp`.
Enable only on the **Vercel project that serves `fleet.dropxlogistics.com`** (see repo scripts referencing `dropx-fleet-test.vercel.app`). Do not expose Fleet MCP on Ops or the main partner dashboard host.

## Endpoints

| URL | Role |
|---|---|
| `https://fleet.dropxlogistics.com/mcp` | MCP JSON-RPC (Bearer only; no session cookie) |
| `https://fleet.dropxlogistics.com/.well-known/oauth-protected-resource` | RFC 9728 resource metadata |
| `https://fleet.dropxlogistics.com/.well-known/oauth-authorization-server` | RFC 8414 AS metadata (PKCE S256, DCR, CIMD) |
| `https://fleet.dropxlogistics.com/api/mcp/oauth/register` | Dynamic client registration (public clients) |
| `https://fleet.dropxlogistics.com/api/mcp/oauth/authorize` | Authorization + consent hand-off |
| `https://fleet.dropxlogistics.com/api/mcp/oauth/token` | Code exchange / refresh |
| `https://fleet.dropxlogistics.com/mcp/consent` | User consent UI (DropX Google session on Fleet host) |

Unauthenticated `GET`/`POST` to `/mcp` returns **401** with
`WWW-Authenticate: Bearer … resource_metadata="https://fleet.dropxlogistics.com/.well-known/oauth-protected-resource"`.

## Auth model

- OAuth 2.1 authorization code + **PKCE S256**.
- User signs in with the existing Fleet / Supabase Google session; Claude never receives browser cookies.
- Claude receives opaque bearer access tokens. Only **SHA-256 hashes** of codes/tokens are stored (`mcp_oauth_*` tables — shared with Ops MCP migration `20261023120000_ops_mcp_oauth.sql`).
- Scope: `fleet.read`.
- After token validation the server loads the DropX user → **fleet** product membership → `company_id` + station scope, then gates tools by Fleet page permissions (same matrix as Fleet Control).

## Tools (read-only)

`tools/list` is **permission-filtered**. Every tool is station-scoped and returns aggregates only (no payment proofs, bank dumps, or write paths).

| Tool | Permission |
|---|---|
| `fleet_list_permitted_stations` | `fleet_vehicle_view` or `fleet_action_center` |
| `fleet_availability_snapshot` | `fleet_action_center` |
| `fleet_service_due_summary` | `fleet_maintenance` |
| `fleet_audit_risk_summary` | `fleet_audits` |
| `fleet_payment_inbox_summary` | `payment_approvals` or `expense_requests` |
| `fleet_attention_summary` | `fleet_action_center` |
| `fleet_mapping_mail_summary` | `fleet_settings` |

Server name in MCP initialize: `dropx-fleet-mcp`.

## Local verification

```bash
pnpm test:mcp
pnpm typecheck
```

## Claude connector URL

Add remote MCP: `https://fleet.dropxlogistics.com/mcp` (Claude discovers OAuth metadata from the 401 / `.well-known` responses).
