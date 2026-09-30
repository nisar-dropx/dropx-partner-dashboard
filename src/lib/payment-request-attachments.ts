export const MAX_PAYMENT_REQUEST_ATTACHMENTS = 3;

export type PaymentRequestAttachment = {
  path: string;
  name: string;
  size: number;
};

type LegacyAttachment = {
  file_path?: string | null;
  file_name?: string | null;
  file_size?: number | null;
  attachments?: unknown;
};

export function paymentRequestAttachments(value: LegacyAttachment | null | undefined): PaymentRequestAttachment[] {
  const stored = Array.isArray(value?.attachments) ? value.attachments : [];
  const parsed = stored.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : "";
    const name = typeof record.name === "string" ? record.name : "";
    const size = typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0;
    return path && name ? [{ path, name, size }] : [];
  });
  if (parsed.length) return parsed.slice(0, MAX_PAYMENT_REQUEST_ATTACHMENTS);
  if (value?.file_path && value.file_name) {
    return [{ path: value.file_path, name: value.file_name, size: Number(value.file_size) || 0 }];
  }
  return [];
}
