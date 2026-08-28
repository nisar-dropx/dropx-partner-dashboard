import { SubmitButton } from "@/components/submit-button";

export type DeductionHead = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  calculation_type: "fixed" | "percentage" | "manual";
  default_value: number;
  is_active: boolean;
};

export function DeductionHeadForm({ action, head, compact = false }: {
  action: (formData: FormData) => Promise<void>;
  head?: DeductionHead;
  compact?: boolean;
}) {
  return <form action={action} className={compact ? "deduction-head-row" : "deduction-head-create"}>
    {head ? <input type="hidden" name="id" value={head.id} /> : null}
    <label>Code<input className="field" name="code" defaultValue={head?.code} disabled={Boolean(head)} required /></label>
    <label>Name<input className="field" name="name" defaultValue={head?.name} required /></label>
    <label>Type<select className="field" name="calculation_type" defaultValue={head?.calculation_type ?? "fixed"}>
      <option value="fixed">Fixed amount</option><option value="percentage">Percentage</option><option value="manual">Manual entry</option>
    </select></label>
    <label>Default value<input className="field" name="default_value" type="number" min="0" step="0.01" defaultValue={head?.default_value ?? 0} /></label>
    <label className="deduction-description">Description<input className="field" name="description" defaultValue={head?.description ?? ""} /></label>
    {head ? <label>Status<select className="field" name="is_active" defaultValue={String(head.is_active)}><option value="true">Active</option><option value="false">Inactive</option></select></label> : null}
    <SubmitButton className="button primary" pendingText="Saving">{head ? "Save" : "Add deduction head"}</SubmitButton>
  </form>;
}
