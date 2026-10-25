import { EvidencePreview } from "@/components/evidence-preview";
import { paymentRequestAttachments } from "@/lib/payment-request-attachments";

type SavedAnswer = { id: string; question_id: string; answer_value: string | null; file_path?: string | null; file_name?: string | null; file_size?: number | null; attachments?: unknown };
/** Both stages remain readable even when only payment details need correction. */
export function PaymentResubmissionSavedDetails({ answers, questions, remarks, original = false }: {
  remarks?: string | null; original?: boolean; answers: SavedAnswer[]; questions: { id: string; question_text: string }[];
}) {
  const names = new Map(questions.map(question => [question.id, question.question_text]));
  const saved = answers.filter(answer => answer.answer_value?.trim() || paymentRequestAttachments(answer).length);
  if (!saved.length && !remarks) return null;
  return <details className="resubmit-disclosure resubmit-saved">
    <summary>Request details <span>{saved.length ? `${saved.length} saved fields` : "Earlier context"}</span></summary>
    {remarks ? <div className="resubmit-original"><strong>{original ? "Original request" : "Previously saved remarks"}</strong><p>{remarks}</p></div> : null}
    <dl>{saved.map(answer => <div key={answer.id}>
      <dt>{names.get(answer.question_id) ?? "Previously saved field"}</dt>
      <dd>{answer.answer_value ? <p>{answer.answer_value}</p> : null}
        {paymentRequestAttachments(answer).map((file, index) => <EvidencePreview key={file.path}
          href={`/api/payments/requests/attachment?answer_id=${encodeURIComponent(answer.id)}&attachment_index=${index}`}
          label={file.name} fileName={file.name} className="resubmit-file-link" />)}
      </dd>
    </div>)}</dl>
  </details>;
}
