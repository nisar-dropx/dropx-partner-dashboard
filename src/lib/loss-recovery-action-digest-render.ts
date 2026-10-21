/** Pure HTML/text for the loss-recovery action digest (no DB). Used by the builder and sample docs/tests. */

export type LossRecoveryDigestRow = {
  station_code: string;
  month: string;
  case_key: string;
  report: string;
  amount: number;
  lifecycle_status: string;
  action_key: string;
  action_label: string;
  owner_role: string;
  age_days: number;
  due_month: string | null;
  blocker: string | null;
  deep_link: string;
};

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export const lossRecoveryDigestMoney = (n: number) =>
  `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function lossRecoveryDigestSubject(template: string, date: string) {
  const subject = (template || "DropX · Loss recovery actions · {{date}}").replaceAll("{{date}}", date);
  if (!subject || /[\r\n]/.test(subject)) throw new Error("Invalid loss recovery email subject.");
  return subject;
}

export function renderLossRecoveryDigestEmail(input: {
  date: string;
  recipientName: string;
  rows: LossRecoveryDigestRow[];
  opsBaseUrl?: string;
}) {
  const base = (input.opsBaseUrl || "https://ops.dropxlogistics.com").replace(/\/$/, "");
  const table = `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px"><thead><tr>${["Station", "Case", "Amount", "Action", "Age", "Due", "Blocker"].map((h) => `<th align="left" style="padding:8px;background:#18243d;color:#fff">${h}</th>`).join("")}</tr></thead><tbody>${input.rows
    .map(
      (r, i) =>
        `<tr style="background:${i % 2 ? "#f2f5fa" : "#fff"}"><td style="padding:8px;border-bottom:1px solid #e3e8f1">${esc(r.station_code)}</td><td style="padding:8px;border-bottom:1px solid #e3e8f1"><a href="${esc(base)}${esc(r.deep_link)}">${esc(r.case_key)}</a></td><td style="padding:8px;border-bottom:1px solid #e3e8f1">${esc(lossRecoveryDigestMoney(r.amount))}</td><td style="padding:8px;border-bottom:1px solid #e3e8f1">${esc(r.action_label)}</td><td style="padding:8px;border-bottom:1px solid #e3e8f1">${esc(r.age_days)}d</td><td style="padding:8px;border-bottom:1px solid #e3e8f1">${esc(r.due_month || "—")}</td><td style="padding:8px;border-bottom:1px solid #e3e8f1">${esc(r.blocker || "—")}</td></tr>`,
    )
    .join("")}</tbody></table>`;
  const html = `<!doctype html><html><body style="margin:0;background:#edf1f7;font-family:Arial,sans-serif;color:#1b2942"><table role="presentation" width="100%"><tr><td align="center" style="padding:22px 10px"><table role="presentation" width="720" style="width:100%;max-width:720px;background:#fff;border-radius:12px;overflow:hidden"><tr><td style="padding:22px;background:#18243d;color:#fff"><div style="font-size:11px;letter-spacing:1px">DROPX · OPS PULSE</div><h1 style="margin:8px 0 0;font-size:22px">Loss recovery actions</h1><div style="opacity:.85;margin-top:6px">${esc(input.date)} · ${input.rows.length} open</div></td></tr><tr><td style="padding:22px"><p>Hello ${esc(input.recipientName)},</p><p style="font-size:14px;line-height:1.5">These are unresolved NL/SLP loss actions in your scope. Empty days do not send mail.</p>${table}<p style="margin-top:18px"><a href="${esc(base)}/team-ops/losses/nl" style="background:#ee5427;color:#fff;padding:10px 14px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:13px">Open Losses →</a></p></td></tr></table></td></tr></table></body></html>`;
  const text = `DropX loss recovery actions · ${input.date}\n\nHello ${input.recipientName},\n${input.rows.length} open actions.\n\n${input.rows
    .map(
      (r) =>
        `${r.station_code} | ${r.case_key} | ${lossRecoveryDigestMoney(r.amount)} | ${r.action_label} | age ${r.age_days}d | due ${r.due_month || "—"} | ${r.blocker || "—"} | ${base}${r.deep_link}`,
    )
    .join("\n")}\n\nOpen Losses: ${base}/team-ops/losses/nl`;
  return { html, text };
}
