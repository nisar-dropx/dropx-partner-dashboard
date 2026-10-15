import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadReviewAction(currentProfile, verificationRows = [], options = {}) {
  let updatePayload = null;
  const updateFilters = [];
  const notifications = [];
  const revalidated = [];

  const query = (table) => {
    let operation = "read";
    const chain = {
      eq(column, value) {
        if (operation === "update") updateFilters.push([column, value]);
        return chain;
      },
      maybeSingle() {
        if (operation === "update") {
          return Promise.resolve({
            data: options.staleUpdate ? null : { id: currentProfile.id },
            error: null
          });
        }
        return Promise.resolve({ data: currentProfile, error: null });
      },
      select() {
        return chain;
      },
      limit() {
        return Promise.resolve({
          data: table === "connect_profile_verifications" ? verificationRows : null,
          error: null
        });
      },
      then(resolve, reject) {
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
      update(payload) {
        operation = "update";
        updatePayload = payload;
        return chain;
      }
    };
    return chain;
  };

  const modules = {
    "next/cache": {
      revalidatePath(path) {
        revalidated.push(path);
      }
    },
    "next/navigation": {
      redirect(path) {
        const error = new Error(`Redirected to ${path}`);
        error.digest = `NEXT_REDIRECT;${path}`;
        throw error;
      }
    },
    "@/lib/app-notifications": {
      async createAppNotification(input) {
        notifications.push(input);
      }
    },
    "@/lib/authorization": {
      async requirePagePermission() {
        return {
          hasAllLocationAccess: true,
          locationScopeIds: [],
          permissions: {},
          userId: "reviewer-user"
        };
      }
    },
    "@/lib/company-scope": {
      requireCompanyId() {
        return "company-id";
      }
    },
    "@/lib/position-access": {
      async assignEmployeeToPosition() {}
    },
    "@/lib/supabase-admin": {
      supabaseAdmin: {
        from(table) {
          return query(table);
        }
      }
    },
    "@/lib/workforce-profiles": {
      isWorkforceProfileType(value) {
        return ["employee", "workforce", "contractor", "vendor", "worker"].includes(String(value));
      },
      nonEmployeeProfileConfigs: {
        contractor: { label: "Independent contractor", route: "/contractors", table: "contractors" },
        vendor: { label: "Vendor", route: "/vendors", table: "vendors" },
        worker: { label: "Helper", route: "/helpers", table: "helpers" }
      },
      workforceTable(profileType) {
        if (profileType === "employee") return "employees";
        if (profileType === "workforce") return "workforce";
        return `${profileType}s`;
      }
    }
  };

  const source = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const module = { exports: {} };
  new Function("require", "exports", "module", compiled)(
    (name) => {
      if (name in modules) return modules[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
    module.exports,
    module
  );

  return {
    reviewPeopleProfile: module.exports.reviewPeopleProfile,
    result: () => ({ notifications, revalidated, updateFilters, updatePayload })
  };
}

function reviewForm(action = "approve", reviewVersion = "2026-10-15T08:00:00.000Z") {
  const form = new FormData();
  form.set("id", "workforce-id");
  form.set("profile_type", "workforce");
  form.set("review_action", action);
  form.set("review_version", reviewVersion);
  if (action === "return") form.set("return_remarks", "Correct the submitted documents.");
  return form;
}

test("review action rejects a profile version newer than the review modal", async () => {
  const harness = loadReviewAction({
    id: "workforce-id",
    location_id: "station-id",
    onboarding_status: "under_review",
    profile_edit_review_pending: true,
    updated_at: "2026-10-15T08:01:00.000Z"
  });
  await assert.rejects(
    harness.reviewPeopleProfile(reviewForm("approve", "2026-10-15T08:00:00.000Z")),
    (error) => String(error?.digest ?? "").startsWith("NEXT_REDIRECT;/people/review?error=") &&
      String(error?.digest ?? "").includes("Profile+changed+while+you+were+reviewing+it")
  );
  const result = harness.result();
  assert.equal(result.updatePayload, null);
  assert.deepEqual(result.notifications, []);
});

async function submitReview(currentProfile, action = "approve", verificationRows = []) {
  const harness = loadReviewAction({
    id: "workforce-id",
    location_id: "station-id",
    onboarding_status: "under_review",
    profile_edit_review_pending: false,
    updated_at: "2026-10-15T08:00:00.000Z",
    ...currentProfile
  }, verificationRows);
  await assert.rejects(
    harness.reviewPeopleProfile(reviewForm(action)),
    (error) => String(error?.digest ?? "").startsWith("NEXT_REDIRECT;/people/review?notice=")
  );
  return harness.result();
}

async function submitStaleReview(action) {
  const harness = loadReviewAction({
    id: "workforce-id",
    location_id: "station-id",
    onboarding_status: "under_review",
    profile_edit_review_pending: true,
    updated_at: "2026-10-15T08:00:00.000Z"
  }, [], { staleUpdate: true });
  await assert.rejects(
    harness.reviewPeopleProfile(reviewForm(action)),
    (error) => {
      const digest = String(error?.digest ?? "");
      return digest.startsWith("NEXT_REDIRECT;/people/review?error=") &&
        digest.includes("Profile+changed+while+you+were+reviewing+it");
    }
  );
  return harness.result();
}

test("People Review explicitly approves a required existing-person exception when activating Workforce", async () => {
  const result = await submitReview({ identity_exception_required: true });

  assert.equal(result.updatePayload.onboarding_status, "active");
  assert.equal(result.updatePayload.lifecycle_status, "active");
  assert.equal(result.updatePayload.is_active, true);
  assert.match(result.updatePayload.identity_exception_approved_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.updatePayload.identity_exception_approved_by, "reviewer-user");
  assert.equal(result.updatePayload.profile_edit_review_pending, false);
  assert.equal(result.notifications[0]?.eventCode, "profile_approved");
  assert.ok(result.revalidated.includes("/people/review"));
});

test("People Review does not stamp an identity exception when none is required", async () => {
  const result = await submitReview({ identity_exception_required: false });

  assert.equal(result.updatePayload.onboarding_status, "active");
  assert.equal(result.updatePayload.lifecycle_status, "active");
  assert.equal(result.updatePayload.is_active, true);
  assert.equal("identity_exception_approved_at" in result.updatePayload, false);
  assert.equal("identity_exception_approved_by" in result.updatePayload, false);
});

test("returning a Workforce profile never approves its existing-person exception", async () => {
  const result = await submitReview({ identity_exception_required: true }, "return");

  assert.equal(result.updatePayload.onboarding_status, "returned");
  assert.equal(result.updatePayload.lifecycle_status, "onboarding");
  assert.equal(result.updatePayload.is_active, false);
  assert.equal("identity_exception_approved_at" in result.updatePayload, false);
  assert.equal("identity_exception_approved_by" in result.updatePayload, false);
  assert.equal(result.notifications[0]?.eventCode, "profile_returned");
});

test("returning a self-edit keeps the active profile in the independent review queue", async () => {
  const result = await submitReview(
    {
      identity_exception_required: false,
      onboarding_status: "active",
      lifecycle_status: "active",
      is_active: true,
      profile_edit_review_pending: true
    },
    "return"
  );

  assert.equal(result.updatePayload.onboarding_status, "active");
  assert.equal(result.updatePayload.lifecycle_status, "active");
  assert.equal(result.updatePayload.is_active, true);
  assert.equal(result.updatePayload.profile_edit_review_pending, true);
  assert.equal(result.updatePayload.profile_return_remarks, "Correct the submitted documents.");
  assert.equal(result.notifications[0]?.data.profileEdit, true);
});

for (const action of ["approve", "return"]) {
  test(`stale ${action} is rejected before review side effects`, async () => {
    const result = await submitStaleReview(action);

    assert.deepEqual(result.notifications, []);
    assert.deepEqual(result.revalidated, []);
    assert.ok(result.updateFilters.some(([column, value]) => column === "onboarding_status" && value === "under_review"));
    assert.ok(result.updateFilters.some(([column, value]) => column === "profile_edit_review_pending" && value === true));
    assert.ok(result.updateFilters.some(([column, value]) => column === "updated_at" && value === "2026-10-15T08:00:00.000Z"));
  });
}
