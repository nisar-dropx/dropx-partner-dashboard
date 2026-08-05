import { AppShell } from "@/components/app-shell";
import { AutoGrowTextarea } from "@/components/auto-grow-textarea";
import { PageHead } from "@/components/page-head";
import { PaymentBeneficiaryFields } from "@/components/payment-beneficiary-fields";
import { PaymentRequestForm } from "@/components/payment-request-form";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate } from "@/lib/date-format";
import { paymentFileAccept, paymentFileGroupLabels } from "@/lib/payment-file-types";
import { loadUserPaymentContacts } from "@/lib/payment-contacts";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import type { PaymentMode } from "@/lib/payment-modes";
import { createExpenseRequest, resubmitExpenseRequest, submitPaymentBankDetails } from "@/app/payments/requests/actions";

type LocationRow = {
  id: string;
  station_code: string;
  station_email: string | null;
  station_manager_email: string | null;
  station_name: string | null;
};

type QuestionRow = {
  id: string;
  answer_type: string;
  dropdown_options: string | null;
  field_stage: string | null;
  is_required: boolean;
  question_text: string;
  sort_order: number;
};

type PaymentHeadRow = {
  id: string;
  code: string;
  name: string;
  requires_supporting_document: boolean;
  supported_payment_modes: PaymentMode[] | null;
  payment_head_questions?: QuestionRow[] | null;
};

type PaymentRequestRow = {
  id: string;
  location_id: string | null;
  approval_status: string | null;
  amount: number | null;
  amount_requested: number | null;
  account_holder_name: string | null;
  bank_account_no: string | null;
  created_at: string;
  contact_no: string | null;
  email: string | null;
  ifsc: string | null;
  location_code: string;
  payment_head_id: string;
  request_no: string;
  requested_by: string | null;
  remarks: string | null;
  status: string;
};

type AnswerRow = {
  id: string;
  question_id: string;
  answer_value: string | null;
  file_name: string | null;
  file_path: string | null;
};

type ApprovalRemarkRow = { action: string | null; comments: string | null; created_at: string };

const NO_LOCATION_SCOPE_ID = "00000000-0000-0000-0000-000000000000";

function canSubmitBankDetails(request: PaymentRequestRow, userId: string) {
  if (request.requested_by !== userId) return false;
  const status = String(request.status ?? "").toUpperCase();
  const approvalStatus = String(request.approval_status ?? "").toUpperCase();
  const isRejectedOrReturned = ["REJECTED", "RETURNED", "CANCELLED"].includes(status) || ["REJECTED", "RETURNED", "CANCELLED"].includes(approvalStatus);
  const isAlreadyProcessing = ["PROCESSING", "PROCESSED"].includes(status) || ["PROCESSING", "PROCESSED"].includes(approvalStatus);
  const hasBankDetails = Boolean(request.amount != null && request.bank_account_no?.trim() && request.ifsc?.trim() && request.account_holder_name?.trim());
  const isApproved = status === "APPROVED" || approvalStatus === "APPROVED" || status === "OWNER_APPROVED" || approvalStatus === "OWNER_APPROVED" || approvalStatus.endsWith("_APPROVED");
  return isApproved && !isRejectedOrReturned && !isAlreadyProcessing && !hasBankDetails;
}

function isResubmittable(request: PaymentRequestRow, userId: string) {
  return request.requested_by === userId && (
    String(request.status ?? "").toLowerCase() === "returned" ||
    String(request.approval_status ?? "").toUpperCase() === "RETURNED"
  );
}

function questionStage(question: QuestionRow) {
  return question.field_stage === "payment" ? "payment" : "expense";
}

function questionsForStage(questions: QuestionRow[] | null | undefined, stage: "expense" | "payment") {
  return (questions ?? [])
    .filter((question) => Number(question.sort_order ?? 0) > 0)
    .filter((question) => questionStage(question) === stage)
    .sort((first, second) => first.sort_order - second.sort_order);
}

function optionsFromText(text: string | null) {
  return (text ?? "").split(",").map((option) => option.trim()).filter(Boolean);
}

function paymentDetailInputForQuestion(question: QuestionRow) {
  const name = `answers[${question.id}]`;
  if (question.answer_type === "dropdown") {
    return (
      <select className="field" name={name} required={question.is_required} defaultValue="">
        <option value="">Select</option>
        {optionsFromText(question.dropdown_options).map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  if (question.answer_type === "textarea") {
    return <AutoGrowTextarea name={name} required={question.is_required} rows={3} />;
  }
  if (question.answer_type === "yes_no") {
    return (
      <select className="field" name={name} required={question.is_required} defaultValue="">
        <option value="">Select</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
    );
  }
  if (question.answer_type === "file") {
    return (
      <>
        <input
          accept={paymentFileAccept(question.dropdown_options)}
          className="field"
          name={`files[${question.id}]`}
          required={question.is_required}
          type="file"
        />
        <p className="subtle" style={{ margin: "4px 0 0" }}>Allowed: {paymentFileGroupLabels(question.dropdown_options).join(", ")}</p>
      </>
    );
  }
  return (
    <input
      className="field"
      name={name}
      required={question.is_required}
      step={question.answer_type === "number" ? "0.01" : undefined}
      type={question.answer_type === "number" ? "number" : question.answer_type === "date" ? "date" : "text"}
    />
  );
}

function resubmitInputForQuestion(question: QuestionRow, answer?: AnswerRow) {
  const name = `answers[${question.id}]`;
  if (question.answer_type === "dropdown") {
    return (
      <select className="field" name={name} required={question.is_required} defaultValue={answer?.answer_value ?? ""}>
        <option value="">Select</option>
        {optionsFromText(question.dropdown_options).map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  if (question.answer_type === "textarea") {
    return <AutoGrowTextarea name={name} required={question.is_required} rows={3} defaultValue={answer?.answer_value ?? ""} />;
  }
  if (question.answer_type === "yes_no") {
    return (
      <select className="field" name={name} required={question.is_required} defaultValue={answer?.answer_value ?? ""}>
        <option value="">Select</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
    );
  }
  if (question.answer_type === "file") {
    return (
      <>
        {answer?.file_name ? <p className="subtle" style={{ margin: "4px 0 8px" }}>Current file: {answer.file_name}</p> : null}
        <input
          accept={paymentFileAccept(question.dropdown_options)}
          className="field"
          name={`files[${question.id}]`}
          required={question.is_required && !answer?.file_name}
          type="file"
        />
        <p className="subtle" style={{ margin: "4px 0 0" }}>Allowed: {paymentFileGroupLabels(question.dropdown_options).join(", ")}</p>
      </>
    );
  }
  return (
    <input
      className="field"
      name={name}
      required={question.is_required}
      step={question.answer_type === "number" ? "0.01" : undefined}
      type={question.answer_type === "number" ? "number" : question.answer_type === "date" ? "date" : "text"}
      defaultValue={answer?.answer_value ?? ""}
    />
  );
}

async function loadReturnRemark(companyId: string, requestId: string) {
  if (!supabaseAdmin) return null;
  for (const requestColumn of ["payment_request_id", "request_id"] as const) {
    const result = await supabaseAdmin
      .from("payment_request_approvals")
      .select("action, comments, created_at")
      .eq("company_id", companyId)
      .eq(requestColumn, requestId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (result.error) continue;
    const returnLog = ((result.data ?? []) as ApprovalRemarkRow[]).find((log) => {
      const action = String(log.action ?? "").toLowerCase();
      return action === "returned" || action === "rejected";
    });
    if (returnLog) return returnLog;
  }
  return null;
}

async function loadExpenseRequestData(companyId: string, authorization: AuthorizationContext) {
  if (!supabaseAdmin) {
    return {
      error: "Supabase service role key is not configured.",
      heads: [] as PaymentHeadRow[],
      locations: [] as LocationRow[],
      requests: [] as PaymentRequestRow[]
    };
  }

  let locationsQuery = supabaseAdmin
      .from("stations")
      .select("id, station_code, station_name, station_email, station_manager_email")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("station_code");
  const headsQuery = supabaseAdmin
      .from("payment_heads")
      .select("id, code, name, requires_supporting_document, supported_payment_modes, payment_head_questions (id, question_text, answer_type, dropdown_options, field_stage, is_required, sort_order)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("code");
  let requestsQuery = supabaseAdmin
      .from("payment_requests")
      .select("id, request_no, location_id, location_code, payment_head_id, amount, amount_requested, bank_account_no, ifsc, account_holder_name, contact_no, email, remarks, requested_by, status, approval_status, created_at")
      .eq("company_id", companyId)
      .is("amount", null)
      .order("created_at", { ascending: false })
      .limit(20);

  if (!authorization.hasAllLocationAccess) {
    const locationIds = authorization.locationScopeIds.length
      ? authorization.locationScopeIds
      : [NO_LOCATION_SCOPE_ID];
    locationsQuery = locationsQuery.in("id", locationIds);
    requestsQuery = requestsQuery.in("location_id", locationIds);
  }

  const [locationsResult, headsResult, requestsResult] = await Promise.all([
    locationsQuery,
    headsQuery,
    requestsQuery
  ]);

  const error = locationsResult.error?.message || headsResult.error?.message || requestsResult.error?.message || null;
  return {
    error,
    heads: ((headsResult.data ?? []) as PaymentHeadRow[]).map((head) => ({
      ...head,
      payment_head_questions: questionsForStage(head.payment_head_questions, "expense")
        .concat(questionsForStage(head.payment_head_questions, "payment"))
    })),
    locations: (locationsResult.data ?? []) as LocationRow[],
    requests: (requestsResult.data ?? []) as PaymentRequestRow[]
  };
}

export const dynamic = "force-dynamic";

export default async function ExpenseRequestPage({
  searchParams
}: {
  searchParams?: { bank?: string; expenseError?: string; expenseNotice?: string; resubmit?: string };
}) {
  const authorization = await requirePagePermission("expense_requests", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.expense_requests;
  const { error, heads, locations, requests } = await loadExpenseRequestData(companyId, authorization);
  const savedContacts = await loadUserPaymentContacts(companyId, authorization.userId);
  const scopedLocationIds = new Set(authorization.locationScopeIds);
  const userEmail = authorization.email?.trim().toLowerCase() ?? "";
  const visibleLocations = authorization.hasAllLocationAccess
    ? locations
    : locations.filter((location) => {
        const locationEmail = location.station_email?.trim().toLowerCase();
        const managerEmail = location.station_manager_email?.trim().toLowerCase();
        return scopedLocationIds.has(location.id) ||
          Boolean(userEmail && (locationEmail === userEmail || managerEmail === userEmail));
      });
  const locationOptions = visibleLocations.map((location) => ({ value: location.id, label: location.station_code, helper: location.station_name ?? undefined }));
  const headOptions = heads.map((head) => ({ value: head.id, label: head.name, helper: head.code }));
  const headById = new Map(heads.map((head) => [head.id, head]));
  const bankRequest = searchParams?.bank
    ? requests.find((request) => request.id === searchParams.bank && canSubmitBankDetails(request, authorization.userId)) ?? null
    : null;
  const bankHead = bankRequest ? headById.get(bankRequest.payment_head_id) ?? null : null;
  const bankQuestions = questionsForStage(bankHead?.payment_head_questions, "payment");
  const resubmitRequest = searchParams?.resubmit
    ? requests.find((request) => request.id === searchParams.resubmit && isResubmittable(request, authorization.userId)) ?? null
    : null;
  const resubmitHead = resubmitRequest ? headById.get(resubmitRequest.payment_head_id) ?? null : null;
  const resubmitQuestions = questionsForStage(resubmitHead?.payment_head_questions, "expense");
  const [resubmitAnswersResult, returnRemark] = resubmitRequest && supabaseAdmin
    ? await Promise.all([
        supabaseAdmin
          .from("payment_request_answers")
          .select("id, question_id, answer_value, file_name, file_path")
          .eq("company_id", companyId)
          .eq("payment_request_id", resubmitRequest.id),
        loadReturnRemark(companyId, resubmitRequest.id)
      ])
    : [{ data: [] as AnswerRow[] }, null];
  const answerByQuestionId = new Map(((resubmitAnswersResult.data ?? []) as AnswerRow[]).map((answer) => [answer.question_id, answer]));

  return (
    <AppShell active="Expense Request" pageCode="expense_requests">
      <PageHead
        eyebrow="Payments"
        title="Expense Request"
        subtitle="Request approval for an expense before collecting bank details for payment processing."
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

      {searchParams?.expenseError || searchParams?.expenseNotice ? (
        <section className={`panel message-panel ${searchParams.expenseError ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{searchParams.expenseError ? "Expense request not saved" : "Expense request saved"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{searchParams.expenseError ?? searchParams.expenseNotice}</p>
          </div>
        </section>
      ) : null}

      {!error && pagePermission.canAdd ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>New expense request</h2>
              <p className="subtle">Select a location and payment head, then enter the estimated amount and required fields.</p>
            </div>
          </div>
          <PaymentRequestForm
            action={createExpenseRequest}
            amountLabel="Estimated Amount"
            headOptions={headOptions}
            heads={heads.map((head) => ({ ...head, payment_head_questions: questionsForStage(head.payment_head_questions, "expense") }))}
            locationOptions={locationOptions}
            showBankDetails={false}
            submitLabel="Submit for approval"
          />
        </section>
      ) : null}

      {!error && pagePermission.canView ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Recent expense requests</h2>
              <p className="subtle">{requests.length} latest records</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Location</th>
                  <th>Payment Head</th>
                  <th>Estimated Amount</th>
                  <th>Status</th>
                  <th>Created</th>
                  {pagePermission.canAdd ? <th>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {requests.length ? requests.map((request) => (
                  <tr key={request.id}>
                    <td><strong>{request.request_no}</strong></td>
                    <td>{request.location_code}</td>
                    <td>{headById.get(request.payment_head_id)?.name ?? "-"}</td>
                    <td>{request.amount_requested == null ? "-" : `Rs ${Number(request.amount_requested).toLocaleString("en-IN")}`}</td>
                    <td><StatusPill status={request.approval_status || request.status} /></td>
                    <td>{formatDashboardDate(request.created_at)}</td>
                    {pagePermission.canAdd ? (
                      <td>
                        {isResubmittable(request, authorization.userId) ? (
                          <PendingLink className="button compact" href={`/payments/expense-request?resubmit=${request.id}`} scroll={false}>Resubmit</PendingLink>
                        ) : canSubmitBankDetails(request, authorization.userId) ? (
                          <PendingLink className="button compact" href={`/payments/expense-request?bank=${request.id}`} scroll={false}>Submit details</PendingLink>
                        ) : "-"}
                      </td>
                    ) : null}
                  </tr>
                )) : (
                  <tr><td className="empty-cell" colSpan={pagePermission.canAdd ? 7 : 6}>No expense requests added yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {resubmitRequest ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide-modal" role="dialog" aria-modal="true" aria-labelledby="expense-resubmit-title">
            <div className="panel-head">
              <div>
                <h2 id="expense-resubmit-title">Correct and resubmit expense request</h2>
                <p className="subtle">{resubmitRequest.request_no} - Update the returned details and send it back for approval.</p>
              </div>
              <PendingLink className="icon-button" href="/payments/expense-request" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <form action={resubmitExpenseRequest} className="panel-body payment-resubmit-form" encType="multipart/form-data">
              <input type="hidden" name="request_id" value={resubmitRequest.id} />
              {returnRemark?.comments ? (
                <div className="message-panel warn" style={{ marginBottom: 16 }}>
                  <strong>Return remarks</strong>
                  <p className="subtle" style={{ marginTop: 6 }}>{returnRemark.comments}</p>
                </div>
              ) : null}
              <div className="form-grid three">
                <label>
                  Location
                  <input className="field" value={resubmitRequest.location_code} readOnly />
                </label>
                <label>
                  Payment Head
                  <input className="field" value={resubmitHead?.name ?? "-"} readOnly />
                </label>
                <label>
                  Estimated Amount *
                  <input className="field" min="0" name="amount" required step="0.01" type="number" defaultValue={resubmitRequest.amount_requested ?? ""} />
                </label>
                {resubmitQuestions.map((question) => {
                  const isWideField = question.answer_type === "textarea";
                  return (
                    <label key={question.id} className={isWideField ? "span-3" : undefined}>
                      {question.question_text}{question.is_required ? " *" : ""}
                      <input type="hidden" name="question_ids" value={question.id} />
                      {resubmitInputForQuestion(question, answerByQuestionId.get(question.id))}
                    </label>
                  );
                })}
              </div>
              <label className="payment-resubmit-remarks">
                Resubmission remarks *
                <AutoGrowTextarea className="field" name="remarks" required rows={3} defaultValue={resubmitRequest.remarks ?? ""} />
              </label>
              <div className="form-actions modal-actions">
                <PendingLink className="button secondary" href="/payments/expense-request" scroll={false}>Cancel</PendingLink>
                <SubmitButton pendingText="Resubmitting">Resubmit request</SubmitButton>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {bankRequest ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide-modal" role="dialog" aria-modal="true" aria-labelledby="expense-bank-payment-title">
            <div className="panel-head">
              <div>
                <h2 id="expense-bank-payment-title">Submit payment details</h2>
                <p className="subtle">{bankRequest.request_no} - Enter the actual amount and choose one payment method.</p>
              </div>
              <PendingLink className="icon-button" href="/payments/expense-request" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <form action={submitPaymentBankDetails} className="panel-body payment-resubmit-form" encType="multipart/form-data">
              <input type="hidden" name="request_id" value={bankRequest.id} />
              <input type="hidden" name="return_to" value="expense" />
              <div className="form-grid three">
                <label>
                  Location
                  <input className="field" value={bankRequest.location_code} readOnly />
                </label>
                <label>
                  Payment Head
                  <input className="field" value={bankHead?.name ?? "-"} readOnly />
                </label>
                <label>
                  Estimated Amount
                  <input className="field" value={bankRequest.amount_requested == null ? "-" : `Rs ${Number(bankRequest.amount_requested).toLocaleString("en-IN")}`} readOnly />
                </label>
                <label>
                  Actual Amount *
                  <input className="field" min="0" name="amount" placeholder="Enter actual amount" required step="0.01" type="number" />
                </label>
              </div>
              <PaymentBeneficiaryFields
                allowedPaymentModes={bankHead?.supported_payment_modes}
                defaultBankAccountNo={bankRequest.bank_account_no}
                defaultContactNo={bankRequest.contact_no}
                defaultEmail={bankRequest.email}
                defaultIfsc={bankRequest.ifsc}
                savedContacts={savedContacts}
              />
              {bankQuestions.length ? (
                <>
                  <div className="section-divider" />
                  <div className="form-grid three">
                    {bankQuestions.map((question) => {
                      const questionLabel = question.question_text.toLowerCase();
                      const isWideField = question.answer_type === "textarea" || questionLabel.includes("mail subject") || questionLabel.includes("subject");
                      return (
                        <label key={question.id} className={isWideField ? "span-3" : undefined}>
                          {question.question_text}{question.is_required ? " *" : ""}
                          <input type="hidden" name="question_ids" value={question.id} />
                          {paymentDetailInputForQuestion(question)}
                        </label>
                      );
                    })}
                  </div>
                </>
              ) : null}
              <label className="payment-resubmit-remarks">
                Remarks
                <textarea className="field" name="remarks" rows={3} defaultValue={bankRequest.remarks ?? ""} />
              </label>
              <div className="form-actions modal-actions">
                <PendingLink className="button secondary" href="/payments/expense-request" scroll={false}>Cancel</PendingLink>
                <SubmitButton pendingText="Submitting">Submit details</SubmitButton>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
