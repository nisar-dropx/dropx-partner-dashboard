import { PaymentResubmissionSavedDetails } from "@/components/payment-resubmission-saved-details";
import { EvidencePreview } from "@/components/evidence-preview";
import { PaymentResubmissionContext } from "@/components/payment-resubmission-context";
import { PaymentResubmissionFields } from "@/components/payment-resubmission-fields";
import { loadResubmissionContext } from "@/lib/payment-resubmission-context";
import { resubmissionQuestions, resubmissionOptions, isFixedReplacementQuestion } from "@/lib/payment-resubmission";
import { PaymentTrackingInput } from "@/components/payment-tracking-input";
import { isPaymentTrackingQuestion } from "@/lib/payment-shipment-count";
import { AppShell } from "@/components/app-shell";
import { AutoGrowTextarea } from "@/components/auto-grow-textarea";
import { PageHead } from "@/components/page-head";
import { PaymentBeneficiaryFields } from "@/components/payment-beneficiary-fields";
import { AdhocDaFields } from "@/components/adhoc-da-fields";
import { PaymentRequestForm } from "@/components/payment-request-form";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate } from "@/lib/date-format";
import { paymentFileAccept, paymentFileGroupLabels } from "@/lib/payment-file-types";
import { paymentRequestAttachments } from "@/lib/payment-request-attachments";
import { loadUserPaymentContacts } from "@/lib/payment-contacts";
import { paymentApprovalStatusTone, paymentStatusLabel } from "@/lib/payment-status-label";
import { hasSubmittedPaymentDetails } from "@/lib/payment-details";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import type { PaymentMode } from "@/lib/payment-modes";
import { createExpenseRequest, resubmitExpenseRequest, resubmitPaymentRequest, submitPaymentBankDetails } from "@/app/payments/requests/actions";
import { paymentQuestionDateBoundsForValue } from "@/lib/payment-question-date-rules";

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
  date_rule?: string | null;
  date_days?: number | null;
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
  current_approver_role_id: string | null;
  current_approver_role_ids: string[] | null;
  current_approver_user_id: string | null;
  email: string | null;
  ifsc: string | null;
  location_code: string;
  payment_head_id: string;
  payment_mode: PaymentMode | null;
  payment_portal: string | null;
  payment_reference: string | null;
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
  file_size?: number | null;
  attachments?: unknown;
};


const NO_LOCATION_SCOPE_ID = "00000000-0000-0000-0000-000000000000";

function hasCurrentApprover(request: PaymentRequestRow) {
  return Boolean(request.current_approver_user_id || request.current_approver_role_id || request.current_approver_role_ids?.length);
}

function isFinalApprovalComplete(request: PaymentRequestRow) {
  const status = String(request.status ?? "").toUpperCase();
  const approvalStatus = String(request.approval_status ?? "").toUpperCase();
  const approved = status === "APPROVED" || approvalStatus === "APPROVED" || status.endsWith("_APPROVED") || approvalStatus.endsWith("_APPROVED");
  return approved && !hasCurrentApprover(request);
}

function displayApprovalStatus(request: PaymentRequestRow) {
  return paymentStatusLabel(request);
}

function canSubmitBankDetails(request: PaymentRequestRow, userId: string) {
  if (request.requested_by !== userId) return false;
  const status = String(request.status ?? "").toUpperCase();
  const approvalStatus = String(request.approval_status ?? "").toUpperCase();
  const isRejectedOrReturned = ["REJECTED", "RETURNED", "CANCELLED"].includes(status) || ["REJECTED", "RETURNED", "CANCELLED"].includes(approvalStatus);
  const isAlreadyProcessing = ["PROCESSING", "PROCESSED"].includes(status) || ["PROCESSING", "PROCESSED"].includes(approvalStatus);
  return isFinalApprovalComplete(request) && !isRejectedOrReturned && !isAlreadyProcessing && !hasSubmittedPaymentDetails(request);
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
  if (isPaymentTrackingQuestion(question)) return <PaymentTrackingInput name={name} required={question.is_required} disabled={false} />;
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
          multiple
          name={`files[${question.id}]`}
          required={question.is_required}
          type="file"
        />
        <p className="subtle" style={{ margin: "4px 0 0" }}>{question.is_required ? "Upload up to 3 files." : "Optional · upload up to 3 files."} Allowed: {paymentFileGroupLabels(question.dropdown_options).join(", ")}</p>
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

function resubmitInputForQuestion(question: QuestionRow, answer?: AnswerRow, reasonKey?: string | null) {
  const name = `answers[${question.id}]`;
  const attachments = paymentRequestAttachments(answer);
  if (isFixedReplacementQuestion(reasonKey, question.question_text, answer?.answer_value)) return <>
    <input className="field" name={name} value={answer?.answer_value ?? ""} readOnly />
    <small className="helper-text">Saved vehicle context · cannot be changed here.</small>
  </>;

  if (isPaymentTrackingQuestion(question)) return <PaymentTrackingInput key={answer?.id ?? question.id} name={name} required={question.is_required} disabled={false} defaultValue={answer?.answer_value ?? ""} />;
  if (question.answer_type === "dropdown") {
    return (
      <select className="field" name={name} required={question.is_required} defaultValue={answer?.answer_value ?? ""}>
        <option value="">Select</option>
        {resubmissionOptions(question.dropdown_options, answer?.answer_value).map((option) => <option key={option} value={option}>{option}</option>)}
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
        {attachments.length ? <div className="subtle" style={{ margin: "4px 0 8px" }}>Saved files: {attachments.map((attachment, index) => <span key={attachment.path}>{index ? ", " : ""}<EvidencePreview href={`/api/payments/requests/attachment?answer_id=${encodeURIComponent(answer!.id)}&attachment_index=${index}`} label={attachment.name} fileName={attachment.name} className="resubmit-file-link" /></span>)}</div> : null}
        <input
          accept={paymentFileAccept(question.dropdown_options)}
          className="field"
          multiple
          name={`files[${question.id}]`}
          required={question.is_required && !attachments.length}
          type="file"
        />
        <p className="subtle" style={{ margin: "4px 0 0" }}>{question.is_required && !attachments.length ? "Upload up to 3 files." : "Keep saved files, or replace with up to 3 files."} New uploads replace saved files.</p>
      </>
    );
  }
  const dateBounds = question.answer_type === "date"
    ? paymentQuestionDateBoundsForValue(question, answer?.answer_value)
    : null;
  return (
    <>
      <input
        className="field"
        name={name}
        required={question.is_required}
        step={question.answer_type === "number" ? "0.01" : undefined}
        type={question.answer_type === "number" ? "number" : question.answer_type === "date" ? "date" : "text"}
        defaultValue={answer?.answer_value ?? ""}
        min={dateBounds?.min}
        max={dateBounds?.max}
      />
      {dateBounds?.helper ? <span className="helper-text">Allowed: {dateBounds.helper}</span> : null}
    </>
  );
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
      .select("id, code, name, requires_supporting_document, supported_payment_modes, payment_head_questions (id, question_text, answer_type, dropdown_options, field_stage, is_required, sort_order, date_rule, date_days)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("code");
  let requestsQuery = supabaseAdmin
      .from("payment_requests")
      .select("id, request_no, location_id, location_code, payment_head_id, amount, amount_requested, bank_account_no, ifsc, account_holder_name, contact_no, email, remarks, requested_by, status, approval_status, current_approver_user_id, current_approver_role_id, current_approver_role_ids, payment_mode, payment_portal, payment_reference, created_at")
      .eq("company_id", companyId)
      .is("amount", null)
      .order("created_at", { ascending: false });

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
  const allRequests = (requestsResult.data ?? []) as PaymentRequestRow[];
  const visibleRequestIds = new Set([
    ...allRequests.slice(0, 20).map((request) => request.id),
    ...allRequests.filter((request) => request.requested_by === authorization.userId).map((request) => request.id)
  ]);
  return {
    error,
    heads: ((headsResult.data ?? []) as PaymentHeadRow[]).map((head) => ({
      ...head,
      payment_head_questions: questionsForStage(head.payment_head_questions, "expense")
        .concat(questionsForStage(head.payment_head_questions, "payment"))
    })),
    locations: (locationsResult.data ?? []) as LocationRow[],
    requests: allRequests.filter((request) => visibleRequestIds.has(request.id))
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
  // Returned after payout details were submitted (e.g. by finance): correct the
  // payout details and send it back to processing instead of re-approving the estimate.
  const resubmitPayout = resubmitRequest ? hasSubmittedPaymentDetails(resubmitRequest) : false;
  const resubmitQuestions = resubmissionQuestions(resubmitHead?.payment_head_questions, resubmitPayout ? "payment" : "expense");
  const [resubmitAnswersResult, resubmitContext] = resubmitRequest && supabaseAdmin
    ? await Promise.all([
        supabaseAdmin
          .from("payment_request_answers")
          .select("id, question_id, answer_value, file_name, file_path, file_size, attachments")
          .eq("company_id", companyId)
          .eq("payment_request_id", resubmitRequest.id),
        loadResubmissionContext(companyId, resubmitRequest)
      ])
    : [{ data: [] as AnswerRow[], error: null }, null];
  const answerByQuestionId = new Map(((resubmitAnswersResult.data ?? []) as AnswerRow[]).map((answer) => [answer.question_id, answer]));

  return (
    <AppShell active="Expense Request" pageCode="expense_requests">
      <PageHead
        eyebrow="Payments"
        title="Expense Request"
        subtitle="Request approval first. Add payment details after approval."
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
        <section className="panel payment-entry-workspace">
          <div className="panel-head">
            <div>
              <h2>New expense request</h2>
              <p className="subtle">Choose a location, expense type and estimate.</p>
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
        <section className="panel payment-workspace payment-expense-workspace">
          <div className="panel-head">
            <div>
              <h2>Recent expense requests</h2>
              <p className="subtle">{requests.length} latest records</p>
            </div>
          </div>
          <div className="table-wrap payment-responsive-list">
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
                  <tr key={request.id} className="payment-record">
                    <td className="payment-cell-reference"><strong>{request.request_no}</strong></td>
                    <td className="payment-cell-location">{request.location_code}</td>
                    <td className="payment-cell-head">{headById.get(request.payment_head_id)?.name ?? "-"}</td>
                    <td className="payment-cell-amount"><span className="payment-mobile-label">Estimate </span>{request.amount_requested == null ? "-" : `Rs ${Number(request.amount_requested).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}</td>
                    <td className="payment-cell-status"><StatusPill status={displayApprovalStatus(request)} tone={paymentApprovalStatusTone(request)} /></td>
                    <td className="payment-cell-created">{formatDashboardDate(request.created_at)}</td>
                    {pagePermission.canAdd ? (
                      <td className="payment-cell-action">
                        {isResubmittable(request, authorization.userId) ? (
                          <PendingLink className="button compact payment-action-revise" title="Review the return remarks, correct the request and submit it again for approval." href={`/payments/expense-request?resubmit=${request.id}`} scroll={false}>Correct &amp; resubmit</PendingLink>
                        ) : canSubmitBankDetails(request, authorization.userId) ? (
                          <PendingLink className="button compact payment-action-next" title="Approval is complete. Add payment and beneficiary details to send this request to Finance." href={`/payments/expense-request?bank=${request.id}`} scroll={false}>Add payment details →</PendingLink>
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
          <section className="modal-panel wide-modal payment-correction-modal" role="dialog" aria-modal="true" aria-labelledby="expense-resubmit-title">
            <div className="panel-head">
              <div>
                <h2 id="expense-resubmit-title">{resubmitPayout ? "Correct payment details" : "Correct expense request"}</h2>
                <p className="subtle">{resubmitRequest.request_no}</p>
              </div>
              <PendingLink className="icon-button" href="/payments/expense-request" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <form action={resubmitPayout ? resubmitPaymentRequest : resubmitExpenseRequest} className="panel-body payment-resubmit-form" encType="multipart/form-data">
              <input type="hidden" name="request_id" value={resubmitRequest.id} />
              {resubmitPayout ? <input type="hidden" name="return_to" value="expense" /> : null}
              {resubmitContext ? <PaymentResubmissionContext context={resubmitContext} location={resubmitRequest.location_code} head={resubmitHead?.name ?? "Payment request"} amount={resubmitRequest.amount_requested ?? resubmitRequest.amount} remarks={resubmitRequest.remarks} payout={resubmitPayout} /> : null}
              <PaymentResubmissionSavedDetails remarks={resubmitContext?.originalRemarks || resubmitRequest.remarks} original={Boolean(resubmitContext?.originalRemarks)} answers={Array.from(answerByQuestionId.values())} questions={resubmitHead?.payment_head_questions ?? []} />
              <div className="resubmit-edit-heading"><strong>Corrections</strong><small>Saved details are kept unless changed.</small></div>
              <div className="form-grid two">
                {resubmitPayout ? (
                  <label>
                    Actual Amount *
                    <input className="field" min="0" name="amount" required step="0.01" type="number" defaultValue={resubmitRequest.amount ?? ""} />
                  </label>
                ) : (
                  <label>
                    Estimated Amount *
                    <input className="field" min="0" name="amount" required step="0.01" type="number" defaultValue={resubmitRequest.amount_requested ?? ""} />
                  </label>
                )}
                {resubmitQuestions.filter(question => question.answer_type !== "file" && !isPaymentTrackingQuestion(question)).map(question => (
                  <label key={question.id} className={question.answer_type === "textarea" ? "span-2" : undefined}>
                    {question.question_text}{question.is_required ? " *" : ""}
                    <input type="hidden" name="question_ids" value={question.id} />
                    {resubmitInputForQuestion(question, answerByQuestionId.get(question.id), resubmitContext?.reasonKey)}
                  </label>
                ))}
              </div>
              {resubmitPayout ? (
                <PaymentResubmissionFields title="Payment details" description="Saved method & beneficiary · open to correct" open={!hasSubmittedPaymentDetails(resubmitRequest)}>
                <PaymentBeneficiaryFields
                  allowedPaymentModes={resubmitHead?.supported_payment_modes}
                  defaultAccountHolderName={resubmitRequest.account_holder_name}
                  defaultBankAccountNo={resubmitRequest.payment_mode === "account_transfer" ? resubmitRequest.bank_account_no : null}
                  defaultContactNo={resubmitRequest.contact_no}
                  defaultEmail={resubmitRequest.email}
                  defaultIfsc={resubmitRequest.payment_mode === "account_transfer" ? resubmitRequest.ifsc : null}
                  defaultPaymentMode={resubmitRequest.payment_mode}
                  defaultUpiId={resubmitRequest.payment_mode === "upi_payment" ? resubmitRequest.payment_reference : null}
                  savedContacts={savedContacts}
                />
                </PaymentResubmissionFields>
              ) : null}

              {resubmitQuestions.some(question => question.answer_type === "file" || isPaymentTrackingQuestion(question)) ? (
                <PaymentResubmissionFields title={resubmitQuestions.some(isPaymentTrackingQuestion) ? "Shipments & supporting files" : "Supporting files"} description="Review or update saved evidence" open={resubmitQuestions.some(question => question.is_required && (question.answer_type === "file" ? !paymentRequestAttachments(answerByQuestionId.get(question.id)).length : isPaymentTrackingQuestion(question) && !answerByQuestionId.get(question.id)?.answer_value))}>
                  {resubmitQuestions.filter(question => question.answer_type === "file" || isPaymentTrackingQuestion(question)).map(question => (
                    <label key={question.id} className="span-2">
                      {question.question_text}{question.is_required ? " *" : ""}
                      <input type="hidden" name="question_ids" value={question.id} />
                      {resubmitInputForQuestion(question, answerByQuestionId.get(question.id))}
                    </label>
                  ))}
                </PaymentResubmissionFields>
              ) : null}
              <label className="payment-resubmit-remarks">
                Your response to the reviewer *
                <AutoGrowTextarea className="field" name="remarks" required rows={3} placeholder="Explain what you corrected or clarify the reviewer’s question." />
              </label>
              {resubmitAnswersResult.error ? <p role="alert" className="resubmit-error">Saved details could not be loaded. Reload before resubmitting.</p> : null}
              <div className="form-actions modal-actions">
                <PendingLink className="button secondary" href="/payments/expense-request" scroll={false}>Cancel</PendingLink>
                <SubmitButton disabled={Boolean(resubmitContext?.error || resubmitAnswersResult.error)} className="button payment-action-revise" pendingText="Resubmitting">Send corrected request</SubmitButton>
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
                  <input className="field" value={bankRequest.amount_requested == null ? "-" : `Rs ${Number(bankRequest.amount_requested).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} readOnly />
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
              {bankHead?.code === "ADHOC_DA" && bankRequest.location_id ? <AdhocDaFields locationId={bankRequest.location_id} /> : null}
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
                <SubmitButton className="button payment-action-next" pendingText="Submitting">Send to Finance</SubmitButton>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
