import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadReviewActions(currentProfile, options = {}) {
  let updatePayload = null;
  const updateFilters = [];
  const notifications = [];
  const revalidated = [];

  const query = () => {
    let operation = "read";
    const chain = {
      eq(column, value) {
        if (operation === "update") updateFilters.push([column, value]);
        return chain;
      },
      is(column, value) {
        if (operation === "update") updateFilters.push([column, value]);
        return chain;
      },
      maybeSingle() {
        if (operation === "update") {
          return Promise.resolve({
            data: options.staleUpdate ? null : { id: currentProfile.id },
            error: options.updateError ?? null
          });
        }
        return Promise.resolve({ data: currentProfile, error: options.readError ?? null });
      },
      select() {
        return chain;
      },
      then(resolve, reject) {
        return Promise.resolve({ data: null, error: options.updateError ?? null }).then(resolve, reject);
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
        from() {
          return query();
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
    reviewProfileEdit: module.exports.reviewProfileEdit,
    result: () => ({ notifications, revalidated, updateFilters, updatePayload })
  };
}

function reviewForm(action = "approve") {
  const form = new FormData();
  form.set("id", "workforce-id");
  form.set("profile_type", "workforce");
  form.set("review_action", action);
  if (action === "return") form.set("return_remarks", "Correct the submitted documents.");
  return form;
}

function profileEditForm(action = "approve", reviewVersion = "2026-10-15T08:00:00.000Z") {
  const form = reviewForm(action);
  form.set("review_version", reviewVersion);
  return form;
}

async function submitRegistrationReview(currentProfile, action = "approve") {
  const harness = loadReviewActions({
    id: "workforce-id",
    location_id: "station-id",
    onboarding_status: "under_review",
    ...currentProfile
  });
  await assert.rejects(
    harness.reviewPeopleProfile(reviewForm(action)),
    (error) => String(error?.digest ?? "").startsWith("NEXT_REDIRECT;/people/review?notice=")
  );
  return harness.result();
}

async function submitProfileEdit(currentProfile = {}, action = "approve", options = {}) {
  const harness = loadReviewActions({
    id: "workforce-id",
    location_id: "station-id",
    onboarding_status: "active",
    lifecycle_status: "active",
    is_active: true,
    deleted_at: null,
    deactivated_at: null,
    profile_edit_review_pending: true,
    updated_at: "2026-10-15T08:00:00.000Z",
    ...currentProfile
  }, options);
  await assert.rejects(
    harness.reviewProfileEdit(profileEditForm(action)),
    (error) => String(error?.digest ?? "").startsWith("NEXT_REDIRECT;/people/review?notice=")
  );
  return harness.result();
}

test("ordinary People Review preserves main approval behavior without profile-edit schema", async () => {
  const result = await submitRegistrationReview({ identity_exception_required: true });

  assert.equal(result.updatePayload.onboarding_status, "active");
  assert.equal(result.updatePayload.lifecycle_status, "active");
  assert.equal(result.updatePayload.is_active, true);
  assert.match(result.updatePayload.identity_exception_approved_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.updatePayload.identity_exception_approved_by, "reviewer-user");
  assert.equal("profile_edit_review_pending" in result.updatePayload, false);
  assert.deepEqual(result.updateFilters, [
    ["id", "workforce-id"],
    ["company_id", "company-id"]
  ]);
  assert.equal(result.notifications[0]?.eventCode, "profile_approved");
  assert.ok(result.revalidated.includes("/people/review"));
});

test("ordinary People Review does not stamp an identity exception when none is required", async () => {
  const result = await submitRegistrationReview({ identity_exception_required: false });

  assert.equal(result.updatePayload.onboarding_status, "active");
  assert.equal(result.updatePayload.lifecycle_status, "active");
  assert.equal(result.updatePayload.is_active, true);
  assert.equal("identity_exception_approved_at" in result.updatePayload, false);
  assert.equal("identity_exception_approved_by" in result.updatePayload, false);
});

test("ordinary People Review return preserves main registration behavior", async () => {
  const result = await submitRegistrationReview({ identity_exception_required: true }, "return");

  assert.equal(result.updatePayload.onboarding_status, "returned");
  assert.equal(result.updatePayload.lifecycle_status, "onboarding");
  assert.equal(result.updatePayload.is_active, false);
  assert.equal("profile_edit_review_pending" in result.updatePayload, false);
  assert.equal("identity_exception_approved_at" in result.updatePayload, false);
  assert.equal("identity_exception_approved_by" in result.updatePayload, false);
  assert.equal(result.notifications[0]?.eventCode, "profile_returned");
});

test("ordinary review cannot consume an active self-edit review", async () => {
  const harness = loadReviewActions({
    id: "workforce-id",
    location_id: "station-id",
    onboarding_status: "active",
    lifecycle_status: "active",
    is_active: true,
    profile_edit_review_pending: true,
    updated_at: "2026-10-15T08:00:00.000Z"
  });

  await assert.rejects(
    harness.reviewPeopleProfile(reviewForm()),
    (error) => String(error?.digest ?? "").startsWith("NEXT_REDIRECT;/people/review?error=") &&
      String(error?.digest ?? "").includes("Only+profiles+under+review+can+be+approved+or+returned")
  );
  assert.equal(harness.result().updatePayload, null);
});

test("self-edit approval only clears the independent review state", async () => {
  const result = await submitProfileEdit();

  assert.equal(result.updatePayload.profile_edit_review_pending, false);
  assert.equal(result.updatePayload.profile_return_remarks, null);
  assert.equal(result.updatePayload.profile_returned_at, null);
  for (const field of ["onboarding_status", "lifecycle_status", "is_active", "identity_exception_approved_at"]) {
    assert.equal(field in result.updatePayload, false);
  }
  assert.ok(result.updateFilters.some(([column, value]) => column === "onboarding_status" && value === "active"));
  assert.ok(result.updateFilters.some(([column, value]) => column === "profile_edit_review_pending" && value === true));
  assert.ok(result.updateFilters.some(([column, value]) => column === "is_active" && value === true));
  assert.ok(result.updateFilters.some(([column, value]) => column === "lifecycle_status" && value === "active"));
  assert.ok(result.updateFilters.some(([column, value]) => column === "deleted_at" && value === null));
  assert.ok(result.updateFilters.some(([column, value]) => column === "deactivated_at" && value === null));
  assert.ok(result.updateFilters.some(([column, value]) => column === "updated_at" && value === "2026-10-15T08:00:00.000Z"));
  assert.deepEqual(result.notifications, []);
});

test("returning a self-edit keeps the profile active and records correction remarks", async () => {
  const result = await submitProfileEdit({}, "return");

  assert.equal(result.updatePayload.profile_edit_review_pending, true);
  assert.equal(result.updatePayload.profile_return_remarks, "Correct the submitted documents.");
  assert.match(result.updatePayload.profile_returned_at, /^\d{4}-\d{2}-\d{2}T/);
  for (const field of ["onboarding_status", "lifecycle_status", "is_active"]) {
    assert.equal(field in result.updatePayload, false);
  }
  assert.equal(result.notifications[0]?.data.profileEdit, true);
});

test("self-edit review rejects a stale rendered version before updating", async () => {
  const harness = loadReviewActions({
    id: "workforce-id",
    location_id: "station-id",
    onboarding_status: "active",
    lifecycle_status: "active",
    is_active: true,
    deleted_at: null,
    deactivated_at: null,
    profile_edit_review_pending: true,
    updated_at: "2026-10-15T08:01:00.000Z"
  });

  await assert.rejects(
    harness.reviewProfileEdit(profileEditForm()),
    (error) => String(error?.digest ?? "").startsWith("NEXT_REDIRECT;/people/review?error=") &&
      String(error?.digest ?? "").includes("Profile+changed+while+you+were+reviewing+it")
  );
  const result = harness.result();
  assert.equal(result.updatePayload, null);
  assert.deepEqual(result.notifications, []);
});

for (const [condition, profile] of [
  ["inactive", { lifecycle_status: "inactive", is_active: false }],
  ["outside the active lifecycle", { lifecycle_status: "exited", is_active: true }],
  ["deleted", { deleted_at: "2026-10-15T07:00:00.000Z" }],
  ["deactivated", { deactivated_at: "2026-10-15T07:00:00.000Z" }]
]) {
  test(`self-edit review cannot reactivate a Workforce profile that is ${condition}`, async () => {
    const harness = loadReviewActions({
      id: "workforce-id",
      location_id: "station-id",
      onboarding_status: "active",
      lifecycle_status: "active",
      is_active: true,
      deleted_at: null,
      deactivated_at: null,
      profile_edit_review_pending: true,
      updated_at: "2026-10-15T08:00:00.000Z",
      ...profile
    });

    await assert.rejects(
      harness.reviewProfileEdit(profileEditForm("return")),
      (error) => String(error?.digest ?? "").startsWith("NEXT_REDIRECT;/people/review?error=") &&
        String(error?.digest ?? "").includes("Only+active+profiles+with+changes+awaiting+review")
    );
    const result = harness.result();
    assert.equal(result.updatePayload, null);
    assert.deepEqual(result.notifications, []);
    assert.deepEqual(result.revalidated, []);
  });
}

for (const action of ["approve", "return"]) {
  test(`stale self-edit ${action} CAS is rejected before side effects`, async () => {
    const harness = loadReviewActions({
      id: "workforce-id",
      location_id: "station-id",
      onboarding_status: "active",
      lifecycle_status: "active",
      is_active: true,
      deleted_at: null,
      deactivated_at: null,
      profile_edit_review_pending: true,
      updated_at: "2026-10-15T08:00:00.000Z"
    }, { staleUpdate: true });
    await assert.rejects(
      harness.reviewProfileEdit(profileEditForm(action)),
      (error) => String(error?.digest ?? "").startsWith("NEXT_REDIRECT;/people/review?error=") &&
        String(error?.digest ?? "").includes("Profile+changed+while+you+were+reviewing+it")
    );
    const result = harness.result();
    assert.deepEqual(result.notifications, []);
    assert.deepEqual(result.revalidated, []);
  });
}
