/**
 * Matches the approval-email card style already wired into the HRMS People & Culture
 * portal (src/lib/approval-email-template.ts there): navy header, eyebrow label,
 * heading, gray info box, blue CTA button, numbered steps, gray footer note.
 * Kept in sync by hand since the two apps don't share a package.
 */
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] as string));
}

export function approvalEmailCard(input: {
  brand?: string;
  eyebrow: string;
  heading: string;
  greeting?: string;
  introduction: string;
  infoLabel: string;
  infoValue: string;
  ctaLabel: string;
  ctaUrl: string;
  steps: string[];
  footer?: string;
}) {
  const brand = input.brand ?? "DROPX · PAYMENTS";
  const steps = input.steps.map((step) => `<li style="margin-bottom:10px">${escapeHtml(step)}</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="overflow-wrap:anywhere;margin:0;background:#f3f5f8;color:#203047;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:auto;background:#fff;border:1px solid #e0e5ed;border-radius:8px"><tr><td style="padding:24px 28px;background:#172b45;color:#fff;font-size:13px;letter-spacing:1px">${escapeHtml(brand)}</td></tr><tr><td style="padding:28px"><p style="font-size:12px;color:#52647c">${escapeHtml(input.eyebrow)}</p><h1 style="font-size:22px;line-height:1.35;margin:10px 0 20px">${escapeHtml(input.heading)}</h1>${input.greeting ? `<p>${escapeHtml(input.greeting)}</p>` : ""}<p style="line-height:1.6">${escapeHtml(input.introduction)}</p><p style="padding:16px;background:#f3f6fa;line-height:1.6"><strong>${escapeHtml(input.infoLabel)}</strong><br>${escapeHtml(input.infoValue)}</p>${input.ctaUrl ? `<p style="margin:26px 0"><a href="${escapeHtml(input.ctaUrl)}" style="background:#2257a0;color:white;padding:13px 20px;text-decoration:none;border-radius:4px;display:inline-block">${escapeHtml(input.ctaLabel)}</a></p>` : ""}${steps ? `<h2 style="font-size:16px">How to review and respond</h2><ol style="padding-left:22px;line-height:1.7">${steps}</ol>` : ""}${input.footer ? `<p style="font-size:12px;color:#627087;line-height:1.6;border-top:1px solid #e0e5ed;padding-top:18px">${escapeHtml(input.footer)}</p>` : ""}</td></tr></table></td></tr></table></body></html>`;
}
