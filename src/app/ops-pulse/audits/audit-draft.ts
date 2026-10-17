/**
 * Keeps an in-progress audit form on this device so a closed dialog, a refresh or a
 * dropped connection does not lose the auditor's entries. Attached files are not part
 * of this copy; Save draft uploads them to the audit as saved proof instead.
 */
type DraftField = { name: string; index: number; value?: string; checked?: boolean };
export type AuditFormDraft<Extra> = { savedAt: string; fields: DraftField[]; extra: Extra };

const key = (auditId: string) => `station-audit-draft:${auditId}`;
const skipped = new Set(["audit_id", "updated_at"]);

/** Counts filled values so an empty newer copy cannot replace a draft with real answers. */
export function auditDraftContentScore(draft: AuditFormDraft<unknown> | null | undefined) {
  if (!draft?.fields?.length) return 0;
  let score = 0;
  for (const field of draft.fields) {
    if (field.checked) score += 1;
    else if (typeof field.value === "string" && field.value.trim()) score += 1;
  }
  if (draft.extra && typeof draft.extra === "object") {
    const extra = draft.extra as { shipments?: unknown[]; tidRemarks?: string };
    if (Array.isArray(extra.shipments)) score += extra.shipments.length;
    if (typeof extra.tidRemarks === "string" && extra.tidRemarks.trim() && extra.tidRemarks !== "{}")
      score += 1;
  }
  return score;
}

/** Newer wins, except a blank draft never replaces one that still has answers. */
export function preferAuditDraft<Extra>(
  local: AuditFormDraft<Extra> | null,
  remote: AuditFormDraft<Extra> | null,
) {
  if (!local) return remote;
  if (!remote) return local;
  const localScore = auditDraftContentScore(local);
  const remoteScore = auditDraftContentScore(remote);
  if (localScore > 0 && remoteScore === 0) return local;
  if (remoteScore > 0 && localScore === 0) return remote;
  return remote.savedAt > local.savedAt ? remote : local;
}

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function draftableFields(form: HTMLFormElement) {
  const seen = new Map<string, number>();
  const fields: Array<{ element: Field; name: string; index: number }> = [];
  for (const element of Array.from(form.elements) as Field[]) {
    if (!element.name || skipped.has(element.name)) continue;
    if (element instanceof HTMLInputElement && ["file", "hidden", "submit", "button"].includes(element.type)) continue;
    if (element instanceof HTMLButtonElement) continue;
    const index = seen.get(element.name) ?? 0;
    seen.set(element.name, index + 1);
    fields.push({ element, name: element.name, index });
  }
  return fields;
}

export function saveAuditDraft<Extra>(auditId: string, form: HTMLFormElement, extra: Extra) {
  const fields: DraftField[] = draftableFields(form).map(({ element, name, index }) =>
    element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")
      ? { name, index, checked: element.checked }
      : { name, index, value: element.value },
  );
  const draft: AuditFormDraft<Extra> = { savedAt: new Date().toISOString(), fields, extra };
  try {
    window.localStorage.setItem(key(auditId), JSON.stringify(draft));
    return draft.savedAt;
  } catch {
    return null;
  }
}

export function loadAuditDraft<Extra>(auditId: string): AuditFormDraft<Extra> | null {
  try {
    const raw = window.localStorage.getItem(key(auditId));
    if (!raw) return null;
    const draft = JSON.parse(raw) as AuditFormDraft<Extra>;
    return draft && Array.isArray(draft.fields) ? draft : null;
  } catch {
    return null;
  }
}

/** The stored draft exactly as saved, for sending to the server. */
export function readAuditDraftText(auditId: string) {
  try {
    return window.localStorage.getItem(key(auditId));
  } catch {
    return null;
  }
}

/** Parses a draft fetched from the server; null when it is not a usable draft. */
export function parseAuditDraft<Extra>(text: string | null): AuditFormDraft<Extra> | null {
  if (!text) return null;
  try {
    const draft = JSON.parse(text) as AuditFormDraft<Extra>;
    return draft && Array.isArray(draft.fields) && typeof draft.savedAt === "string" ? draft : null;
  } catch {
    return null;
  }
}

export function clearAuditDraft(auditId: string) {
  try {
    window.localStorage.removeItem(key(auditId));
  } catch {
    // Storage is unavailable; there is nothing to clear.
  }
}

/** Writes a value the way a person typing would, so React-controlled fields update too. */
function writeValue(element: Field, value: string) {
  if (element.value === value) return;
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

/** Returns how many saved fields could not be found yet (they may appear after other fields update). */
export function applyAuditDraft(form: HTMLFormElement, draft: AuditFormDraft<unknown>) {
  const current = draftableFields(form);
  let missing = 0;
  for (const saved of draft.fields) {
    const match = current.find((field) => field.name === saved.name && field.index === saved.index);
    if (!match) {
      missing += 1;
      continue;
    }
    const element = match.element;
    if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
      // A radio can only be switched on; its group switches the others off.
      const turnOn = saved.checked === true && !element.checked;
      const turnOff = saved.checked === false && element.checked && element.type === "checkbox";
      if (turnOn || turnOff) element.click();
    } else if (saved.value !== undefined) {
      writeValue(element, saved.value);
    }
  }
  return missing;
}
