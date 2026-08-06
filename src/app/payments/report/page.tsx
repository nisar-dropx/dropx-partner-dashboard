import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PaymentReportTable, type PaymentReportAnswer, type PaymentReportLog } from "@/components/payment-report-table";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";

type PaymentRequestRow = {
  id: string;
  location_id: string | null;
  request_no: string;
  location_code: string;
  payment_head_id: string;
  amount: number | null;
  bank_account_no: string | null;
  ifsc: string | null;
  account_holder_name: string | null;
  contact_no: string | null;
  email: string | null;
  remarks: string | null;
  supporting_document_path: string | null;
  status: string;
  approval_status: string | null;
  utr_cin: string | null;
  bank_status: string | null;
  bank_processing_remarks: string | null;
  processing_started_at: string | null;
  processed_at: string | null;
  requested_by: string | null;
  created_at: string;
  updated_at: string;
};

type PaymentHeadRow = {
  id: string;
  code: string;
  name: string;
  external_id: string | null;
};

type AnswerRow = {
  id: string;
  payment_request_id: string;
  answer_value: string | null;
  file_name: string | null;
  payment_head_questions?: { question_text: string | null; answer_type: string | null } | null;
};

type ApprovalLogRow = {
  id: string;
  payment_request_id: string;
  action: string;
  comments: string | null;
  created_at: string;
  approver_user_id: string | null;
  approver_role_id: string | null;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string | null;
};

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

const NO_LOCATION_SCOPE_ID = "00000000-0000-0000-0000-000000000000";

async function loadPaymentReport(companyId: string, authorization: AuthorizationContext) {
  if (!supabaseAdmin) {
    return {
      answersByRequestId: new Map<string, PaymentReportAnswer[]>(),
      heads: [] as PaymentHeadRow[],
      logsByRequestId: new Map<string, PaymentReportLog[]>(),
      profilesById: new Map<string, ProfileRow>(),
      requests: [] as PaymentRequestRow[],
      error: "Supabase service role key is not configured."
    };
  }
  let requestsResult: any;
  let headsResult: any;
  let requestsQuery = supabaseAdmin
      .from("payment_requests")
      .select("id, request_no, location_id, location_code, payment_head_id, amount, bank_account_no, ifsc, account_holder_name, contact_no, email, remarks, supporting_document_path, status, approval_status, utr_cin, bank_status, bank_processing_remarks, processing_started_at, processed_at, requested_by, created_at, updated_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });
  if (!authorization.hasAllLocationAccess) {
    requestsQuery = requestsQuery.in("location_id", authorization.locationScopeIds.length ? authorization.locationScopeIds : [NO_LOCATION_SCOPE_ID]);
  }
  [requestsResult, headsResult] = await Promise.all([
    requestsQuery,
    supabaseAdmin
      .from("payment_heads")
      .select("id, code, name, external_id")
      .eq("company_id", companyId)
  ]);

  if (requestsResult.error?.message.toLowerCase().includes("processing_started_at")) {
    let fallbackQuery = supabaseAdmin
      .from("payment_requests")
      .select("id, request_no, location_id, location_code, payment_head_id, amount, bank_account_no, ifsc, account_holder_name, contact_no, email, remarks, supporting_document_path, status, approval_status, utr_cin, bank_status, bank_processing_remarks, processed_at, requested_by, created_at, updated_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });
    if (!authorization.hasAllLocationAccess) {
      fallbackQuery = fallbackQuery.in("location_id", authorization.locationScopeIds.length ? authorization.locationScopeIds : [NO_LOCATION_SCOPE_ID]);
    }
    requestsResult = await fallbackQuery;
  }
  const error = requestsResult.error?.message || headsResult.error?.message || null;
  if (error) {
    return {
      answersByRequestId: new Map<string, PaymentReportAnswer[]>(),
      heads: [] as PaymentHeadRow[],
      logsByRequestId: new Map<string, PaymentReportLog[]>(),
      profilesById: new Map<string, ProfileRow>(),
      requests: [] as PaymentRequestRow[],
      error
    };
  }

  const requests = (requestsResult.data ?? []) as PaymentRequestRow[];
  const requestIds = requests.map((request) => request.id);
  const [answersResult, logsResult] = requestIds.length ? await Promise.all([
    supabaseAdmin
      .from("payment_request_answers")
      .select("id, payment_request_id, answer_value, file_name, payment_head_questions ( question_text, answer_type )")
      .eq("company_id", companyId)
      .in("payment_request_id", requestIds),
    supabaseAdmin
      .from("payment_request_approvals")
      .select("id, payment_request_id, action, comments, created_at, approver_user_id, approver_role_id")
      .eq("company_id", companyId)
      .in("payment_request_id", requestIds)
      .order("created_at", { ascending: true })
  ]) : [{ data: [], error: null }, { data: [], error: null }];

  if (answersResult.error || logsResult.error) {
    return {
      answersByRequestId: new Map<string, PaymentReportAnswer[]>(),
      heads: [] as PaymentHeadRow[],
      logsByRequestId: new Map<string, PaymentReportLog[]>(),
      profilesById: new Map<string, ProfileRow>(),
      requests: [] as PaymentRequestRow[],
      error: answersResult.error?.message || logsResult.error?.message || "Unable to load payment report details."
    };
  }

  const rawLogs = (logsResult.data ?? []) as ApprovalLogRow[];
  const userIds = Array.from(new Set([
    ...rawLogs.map((log) => log.approver_user_id).filter(Boolean),
    ...requests.map((request) => request.requested_by).filter(Boolean)
  ])) as string[];
  const roleIds = Array.from(new Set(rawLogs.map((log) => log.approver_role_id).filter(Boolean))) as string[];
  const [profilesResult, rolesResult] = await Promise.all([
    userIds.length
      ? supabaseAdmin.from("profiles").select("id, full_name, email").eq("company_id", companyId).in("id", userIds)
      : { data: [], error: null },
    roleIds.length
      ? supabaseAdmin.from("user_roles").select("id, name, code").eq("company_id", companyId).in("id", roleIds)
      : { data: [], error: null }
  ]);

  if (profilesResult.error || rolesResult.error) {
    return {
      answersByRequestId: new Map<string, PaymentReportAnswer[]>(),
      heads: [] as PaymentHeadRow[],
      logsByRequestId: new Map<string, PaymentReportLog[]>(),
      profilesById: new Map<string, ProfileRow>(),
      requests: [] as PaymentRequestRow[],
      error: profilesResult.error?.message || rolesResult.error?.message || "Unable to load payment report history."
    };
  }

  const profilesById = new Map(((profilesResult.data ?? []) as ProfileRow[]).map((profile) => [profile.id, profile]));
  const rolesById = new Map((rolesResult.data ?? []).map((role) => [role.id, role]));
  const answersByRequestId = new Map<string, PaymentReportAnswer[]>();
  const logsByRequestId = new Map<string, PaymentReportLog[]>();

  ((answersResult.data ?? []) as unknown as AnswerRow[]).forEach((answer) => {
    const question = firstRelation(answer.payment_head_questions);
    const list = answersByRequestId.get(answer.payment_request_id) ?? [];
    list.push({
      id: answer.id,
      payment_request_id: answer.payment_request_id,
      answer_value: answer.answer_value,
      file_name: answer.file_name,
      question_text: question?.question_text ?? null,
      answer_type: question?.answer_type ?? null
    });
    answersByRequestId.set(answer.payment_request_id, list);
  });

  rawLogs.forEach((log) => {
    const profile = log.approver_user_id ? profilesById.get(log.approver_user_id) : null;
    const role = log.approver_role_id ? rolesById.get(log.approver_role_id) : null;
    const list = logsByRequestId.get(log.payment_request_id) ?? [];
    list.push({
      id: log.id,
      payment_request_id: log.payment_request_id,
      action: log.action,
      comments: log.comments,
      created_at: log.created_at,
      approver_name: profile?.full_name ?? null,
      approver_email: profile?.email ?? null,
      role_name: role?.name ?? null,
      role_code: role?.code ?? null
    });
    logsByRequestId.set(log.payment_request_id, list);
  });

  return {
    answersByRequestId,
    heads: (headsResult.data ?? []) as PaymentHeadRow[],
    logsByRequestId,
    profilesById,
    requests,
    error: null
  };
}

export const dynamic = "force-dynamic";

export default async function PaymentReportPage() {
  const authorization = await requirePagePermission("payment_reports", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.payment_reports;
  const { answersByRequestId, heads, logsByRequestId, profilesById, requests, error } = await loadPaymentReport(companyId, authorization);
  const headById = new Map(heads.map((head) => [head.id, head]));
  const totalAmount = requests.reduce((sum, request) => sum + Number(request.amount ?? 0), 0);

  return (
    <AppShell active="Payment Report" pageCode="payment_reports">
      <PageHead
        eyebrow="Payments"
        title="Report"
        subtitle="Review location expense payment requests."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Payment database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error} Run `scripts/payment_requests_v1.sql` in Supabase SQL Editor, then refresh.</p>
          </div>
        </section>
      ) : null}

      {!error && pagePermission.canView ? (
        <>
          <div className="stat-grid four">
            <div className="stat-card">
              <span>Total requests</span>
              <strong>{requests.length}</strong>
            </div>
            <div className="stat-card">
              <span>Pending</span>
              <strong>{requests.filter((request) => request.status === "pending").length}</strong>
            </div>
            <div className="stat-card">
              <span>Approved</span>
              <strong>{requests.filter((request) => request.status === "approved").length}</strong>
            </div>
            <div className="stat-card">
              <span>Total amount</span>
              <strong>Rs {totalAmount.toLocaleString("en-IN")}</strong>
            </div>
          </div>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Payment request report</h2>
                <p className="subtle">{requests.length} records</p>
              </div>
            </div>
            <PaymentReportTable
              requests={requests.map((request) => {
                const head = headById.get(request.payment_head_id);
                return {
                  id: request.id,
                  request_no: request.request_no,
                  location_code: request.location_code,
                  payment_head_name: head?.name ?? "-",
                  payment_head_external_id: head?.external_id ?? "-",
                  amount: request.amount,
                  account_holder_name: request.account_holder_name,
                  bank_account_no: request.bank_account_no,
                  ifsc: request.ifsc,
                  contact_no: request.contact_no,
                  email: request.email,
                  remarks: request.remarks,
                  supporting_document_path: request.supporting_document_path,
                  status: request.status,
                  approval_status: request.approval_status,
                  utr_cin: request.utr_cin,
                  bank_status: request.bank_status,
                  bank_processing_remarks: request.bank_processing_remarks,
                  processing_started_at: request.processing_started_at,
                  processed_at: request.processed_at,
                  requested_by_name: request.requested_by ? profilesById.get(request.requested_by)?.full_name ?? null : null,
                  requested_by_email: request.requested_by ? profilesById.get(request.requested_by)?.email ?? null : null,
                  created_at: request.created_at,
                  updated_at: request.updated_at,
                  answers: answersByRequestId.get(request.id) ?? [],
                  logs: logsByRequestId.get(request.id) ?? []
                };
              })}
            />
          </section>
        </>
      ) : null}
    </AppShell>
  );
}
