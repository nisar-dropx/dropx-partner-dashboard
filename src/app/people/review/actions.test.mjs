import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadReviewAction(currentProfile) {
  let updatePayload = null;
  const notifications = [];
  const revalidated = [];

  const query = () => {
    const chain = {
      eq() {
        return chain;
      },
      maybeSingle() {
        return Promise.resolve({ data: currentProfile, error: null });
      },
      select() {
        return chain;
      },
      then(resolve, reject) {
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
      update(payload) {
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
    result: () => ({ notifications, revalidated, updatePayload })
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

async function submitReview(currentProfile, action = "approve") {
  const harness = loadReviewAction({
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

test("People Review explicitly approves a required existing-person exception when activating Workforce", async () => {
  const result = await submitReview({ identity_exception_required: true });

  assert.equal(result.updatePayload.onboarding_status, "active");
  assert.match(result.updatePayload.identity_exception_approved_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.updatePayload.identity_exception_approved_by, "reviewer-user");
  assert.equal(result.notifications[0]?.eventCode, "profile_approved");
  assert.ok(result.revalidated.includes("/people/review"));
});

test("People Review does not stamp an identity exception when none is required", async () => {
  const result = await submitReview({ identity_exception_required: false });

  assert.equal(result.updatePayload.onboarding_status, "active");
  assert.equal("identity_exception_approved_at" in result.updatePayload, false);
  assert.equal("identity_exception_approved_by" in result.updatePayload, false);
});

test("returning a Workforce profile never approves its existing-person exception", async () => {
  const result = await submitReview({ identity_exception_required: true }, "return");

  assert.equal(result.updatePayload.onboarding_status, "returned");
  assert.equal("identity_exception_approved_at" in result.updatePayload, false);
  assert.equal("identity_exception_approved_by" in result.updatePayload, false);
  assert.equal(result.notifications[0]?.eventCode, "profile_returned");
});
