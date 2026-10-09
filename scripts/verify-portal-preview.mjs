import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
function moduleAt(path, mocks) {
  const js = ts.transpileModule(fs.readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", js)((id) => { if (!(id in mocks)) throw new Error("Unexpected dependency " + id); return mocks[id]; }, mod, mod.exports);
  return mod.exports;
}
const company = "company-a";
const tables = {
  profiles: [
    { id: "owner", company_id: company, full_name: "Managing Partner", email: "nisar@dropxlogistics.com", is_active: true, is_master_owner: true, role_id: "owner-role", location_scope_ids: [] },
    { id: "station", company_id: company, full_name: "Station", email: null, is_active: true, is_master_owner: false, role_id: "station-role", location_scope_ids: ["station-a"] },
    { id: "other-company", company_id: "company-b", is_active: true },
    { id: "inactive", company_id: company, is_active: false }
  ],
  companies: [{ id: company, is_active: true, is_master: true }],
  user_roles: [
    { id: "owner-role", company_id: company, name: "Owner", code: "OWNER", is_active: true, location_access_mode: "all_locations" },
    { id: "station-role", company_id: company, name: "Location", code: "LOCATION", is_active: true, location_access_mode: "role_based" }
  ],
  company_product_memberships: ["operations", "workforce"].map(product_code => ({ company_id: company, user_id: "station", product_code, is_active: true, role_id: "station-role", location_scope_ids: ["station-a"], has_all_location_access: false })),
  company_product_owners: [],
  app_pages: [{ id: "page", company_id: company, code: "people_all", is_active: true }],
  role_page_permissions: [{ company_id: company, role_id: "station-role", page_id: "page", can_view: true, can_add: true, can_edit: false }],
  stations: [], hr_user_person_links: []
};
function query(table) {
  let rows = [...(tables[table] ?? [])];
  const q = {
    select: () => q, order: () => q, limit: () => q,
    eq: (key, value) => { rows = rows.filter(r => r[key] === value); return q; },
    in: (key, values) => { rows = rows.filter(r => values.includes(r[key])); return q; },
    is: (key, value) => { rows = rows.filter(r => (r[key] ?? null) === value); return q; },
    not: (key, op, value) => { rows = rows.filter(r => r[key] !== value); return q; },
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    then: (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve)
  };
  return q;
}
const admin = { from: query };
const people = moduleAt("src/lib/people-designation.ts", { "@/lib/supabase-admin": { supabaseAdmin: admin } });
assert.equal(people.canPreviewPortalUsers(true, null), true);
assert.equal(people.canPreviewPortalUsers(false, "OWNER"), true);
assert.equal(people.canPreviewPortalUsers(false, null, { code: "FSD", name: "Full Stack Developer", active: true }), true);
assert.equal(people.canPreviewPortalUsers(false, null, { code: "FSD", active: false }), false);
assert.equal(people.canPreviewPortalUsers(false, null, { code: "CLM", active: true }), false);
assert.equal(people.canPreviewPortalUsers(false, "TECH"), false);
let actor = "owner", selected = null, revoked = false;
const mocks = {
  "@/lib/with-timeout": moduleAt("src/lib/with-timeout.ts", {}),
  "next/navigation": { redirect: (url) => { throw new Error(url); } },
  "next/cache": { unstable_cache: fn => fn },
  "next/headers": { cookies: () => ({ get: () => null }) },
  react: { cache: fn => fn },
  "@/lib/access-pages": { accessPages: [{ code: "people_all" }], ensureAccessPages: async () => {} },
  "@/lib/position-access": { loadEffectivePositionAccess: async () => ({ roleIds: [], locationScopeIds: [], hasAllLocationAccess: false }) },
  "@/lib/access-surface": { currentAdminAccessSurface: () => "ops" },
  "@/lib/supabase-admin": { supabaseAdmin: admin },
  "@/lib/access-cutoff": { enforceAccessCutoffIfDue: async () => true },
  "@/lib/supabase-server": { createServerSupabaseClient: () => ({ auth: { getUser: async () => ({ data: { user: tables.profiles.find(p => p.id === actor) } }) } }) },
  "@/lib/people-designation": { loadPeopleDesignations: async (_, ids) => new Map(ids.map(id => [id, { name: id === "owner" ? "Managing Partner" : "Station lead" }])) },
  "@/lib/portal-preview": { getPreviewViewer: async () => actor === "owner" ? tables.profiles[0] : null, selectedPreviewUserId: () => selected, hasPreviewProductAccess: async () => !revoked }
};
// Authorization reads the session and the cached access rows through two shared
// modules; load the real ones against the same mocks so their logic is exercised.
function withSharedModules(base) {
  base = { ...base, "@/lib/auth-session-policy": moduleAt("src/lib/auth-session-policy.ts", {}) };
  return {
    ...base,
    "@/lib/session-user": moduleAt("src/lib/session-user.ts", base),
    "@/lib/access-cache": moduleAt("src/lib/access-cache.ts", base)
  };
}
const auth = moduleAt("src/lib/authorization.ts", withSharedModules(mocks));
class ImmediateTimeout extends Error { constructor() { super("timed out"); this.name = "TimeoutError"; } }
const timeoutAuth = moduleAt("src/lib/authorization.ts", withSharedModules({
  ...mocks,
  "@/lib/with-timeout": { TimeoutError: ImmediateTimeout, withTimeout: async () => { throw new ImmediateTimeout(); } },
  "@/lib/supabase-server": { createServerSupabaseClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }
}));
await assert.rejects(timeoutAuth.getAuthorization(), /not been signed out/, "timeouts must stay retryable, not become a missing session/login redirect");
const unavailableAuth = moduleAt("src/lib/authorization.ts", withSharedModules({
  ...mocks,
  "@/lib/with-timeout": { TimeoutError: ImmediateTimeout, withTimeout: async () => { throw new Error("Supabase auth is unavailable"); } },
  "@/lib/supabase-server": { createServerSupabaseClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }
}));
await assert.rejects(unavailableAuth.getAuthorization(), /Supabase auth is unavailable/, "unexpected upstream failures must reach the retry boundary without granting access or logging out");
const claimsFallbackAuth = moduleAt("src/lib/authorization.ts", withSharedModules({
  ...mocks,
  "@/lib/supabase-server": {
    createServerSupabaseClient: () => ({
      auth: {
        getUser: async () => {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          throw error;
        },
        getClaims: async () => ({ data: { claims: { sub: "owner", email: "nisar@dropxlogistics.com" } } })
      }
    })
  }
}));
const claimsFallbackAuthorization = await claimsFallbackAuth.getAuthorization();
assert.equal(claimsFallbackAuthorization?.userId, "owner", "a valid signed session survives a transient Auth API failure");
assert.equal(claimsFallbackAuthorization?.email, "nisar@dropxlogistics.com");
let authApiCalls = 0;
const localClaimsAuth = moduleAt("src/lib/authorization.ts", withSharedModules({
  ...mocks,
  "@/lib/supabase-server": {
    createServerSupabaseClient: () => ({
      auth: {
        getUser: async () => { authApiCalls += 1; return { data: { user: tables.profiles[0] } }; },
        getClaims: async () => ({ data: { claims: { sub: "owner", email: "nisar@dropxlogistics.com" } } })
      }
    })
  }
}));
assert.equal((await localClaimsAuth.getAuthorization())?.userId, "owner");
assert.equal(authApiCalls, 0, "a locally verified session never calls the Auth API");
const ownerBefore = await auth.getAuthorization();
assert.equal(ownerBefore.designationName, "Managing Partner");
assert.equal(ownerBefore.roleCode, "OWNER");
assert.equal(auth.hasPermission(ownerBefore, "anything", "edit"), true);
actor = "station";
const actualStation = await auth.getAuthorization();
selected = "owner";
await assert.rejects(auth.getAuthorization(), /preview-unavailable/, "ordinary users cannot forge previews");
actor = "owner"; selected = "station";
const preview = await auth.getAuthorization();
assert.equal(preview.userId, "station");
assert.equal(preview.viewerUserId, "owner");
assert.equal(preview.email, null, "target without email must not inherit owner's email");
assert.equal(preview.isMasterOwner, false, "no owner privilege leak into target");
assert.equal(preview.readOnly, true);
assert.equal(preview.designationName, "Station lead");
assert.deepEqual(preview.permissions, actualStation.permissions);
assert.deepEqual(preview.locationScopeIds, actualStation.locationScopeIds);
assert.equal(preview.hasAllLocationAccess, actualStation.hasAllLocationAccess);
assert.equal(auth.hasPermission(preview, "people_all", "add"), false);
assert.equal(auth.hasPermission(preview, "people_all", "view"), true);
for (const invalid of ["other-company", "inactive"]) {
  selected = invalid;
  await assert.rejects(auth.getAuthorization(), /preview-unavailable/, "invalid targets fail closed with an exit control");
}
selected = null;
assert.deepEqual(await auth.getAuthorization(), ownerBefore, "exiting preview restores all original privileges");
selected = "station"; revoked = true;
await assert.rejects(auth.getAuthorization(), /preview-unavailable/, "revoked portal access fails closed with an exit control");
selected = null; revoked = false;
const middleware = fs.readFileSync("src/middleware.ts", "utf8");
assert.match(middleware, /dropx_portal_preview_v1/);
assert.match(middleware, /\["GET", "HEAD", "OPTIONS"\]/);
assert.match(middleware, /path !== "\/api\/owner-preview"/);
const route = fs.readFileSync("src/app/api/owner-preview/route.ts", "utf8");
assert.match(route, /getPreviewViewer/);
assert.match(route, /Same-origin request required/);
assert.match(route, /users.some\(user => user.id === userId\)/);
const helper = fs.readFileSync("src/lib/portal-preview.ts", "utf8");
assert.match(helper, /getSessionUser\(\)/);
const sessionUser = fs.readFileSync("src/lib/session-user.ts", "utf8");
assert.match(sessionUser, /auth.getUser\(\)/);
assert.match(sessionUser, /Session claim check/);
assert.match(sessionUser, /Sign-in check/);
assert.match(helper, /eq\("company_id", viewer.company_id\)/);
assert.match(helper, /eq\("product_code", product\)/);
assert.match(helper, /actor === viewerId/);
assert.match(helper, /no-store/);
const shell = fs.readFileSync("src/components/app-shell.tsx", "utf8");
assert.match(shell, /authorization.designationName \?\? authorization.roleName/);
assert.doesNotMatch(shell, /!isWorkforceHost && authorization.canPreviewUsers/);
const login = fs.readFileSync("src/app/login/page.tsx", "utf8");
assert.match(login, /Login session check/);
assert.match(login, /catch\(\(\) => \(\{ data: \{ user: null \} \}\)\)/);
console.log("Portal preview tests passed: designation display, unchanged owner privileges, target permission and location parity, read-only, company/active/actor boundaries.");
let previewCookie = null;
const realPreview = moduleAt("src/lib/portal-preview.ts", withSharedModules({
  react: { cache: fn => fn },
  "next/cache": mocks["next/cache"],
  "next/headers": { cookies: () => ({ get: () => previewCookie ? { value: previewCookie } : undefined }), headers: () => ({ get: () => "ops.dropxlogistics.com" }) },
  "@/lib/with-timeout": moduleAt("src/lib/with-timeout.ts", {}),
  "@/lib/access-pages": mocks["@/lib/access-pages"],
  "@/lib/supabase-admin": { supabaseAdmin: admin },
  "@/lib/supabase-server": mocks["@/lib/supabase-server"],
  "@/lib/people-designation": { ...mocks["@/lib/people-designation"], canPreviewPortalUsers: people.canPreviewPortalUsers }
}));
actor = "owner";
assert.equal((await realPreview.getPreviewViewer()).id, "owner");
const allowedUsers = await realPreview.listPreviewUsers(tables.profiles[0]);
assert.deepEqual(allowedUsers.map(user => user.id).sort(), ["owner", "station"]);
assert.equal(await realPreview.hasPreviewProductAccess(company, "station", false), true);
assert.equal(await realPreview.hasPreviewProductAccess(company, "unassigned", false), false);
actor = "station";
assert.equal(await realPreview.getPreviewViewer(), null);
previewCookie = "owner:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
assert.equal(realPreview.selectedPreviewUserId("owner"), "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
assert.equal(realPreview.selectedPreviewUserId("different-viewer"), null);
previewCookie = "owner:malformed";
assert.equal(realPreview.selectedPreviewUserId("owner"), null);
console.log("Live helper tests passed: eligible viewer, portal membership, scoped candidates and actor-bound cookie.");
