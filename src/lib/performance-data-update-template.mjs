const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function buildPerformanceDataUpdateMessages(recipients, date, control) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date) throw new Error('A valid performance date is required.');
  const day = new Date(date+'T12:00:00Z');
  const label = day.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Kolkata'});
  const month = day.toLocaleDateString('en-GB',{month:'long',timeZone:'Asia/Kolkata'});
  if (!control.subject_template?.includes('{{month}}') || !control.subject_template?.includes('{{year}}') || /[\r\n]/.test(control.subject_template)) throw new Error('Configure a monthly subject.');
  if (!control.body_template?.includes('{{date}}')) throw new Error('Configure the dated update message.');
  const subject = control.subject_template.replaceAll('{{month}}',month).replaceAll('{{year}}',String(day.getUTCFullYear()));
  const message = control.body_template.replaceAll('{{date}}',label);
  const domain = String(control.config.email_domain||'').toLowerCase();
  if (!domain) throw new Error('Configure the company email domain.');
  const unique = new Map();
  for (const recipient of recipients) {
    const email = String(recipient.email||'').trim().toLowerCase();
    if (!email.endsWith('@'+domain) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new Error('Recipient must use the configured company email domain.');
    const stations = recipient.stations || [];
    if (!stations.length) continue;
    if (unique.has(email)) throw new Error('Conflicting recipient scopes; no mail queued.');
    const codes = [...new Set(stations.map(s=>s.station_code))].sort();
    const url = 'https://ops.dropxlogistics.com/performance?date='+date;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Performance data updated</title></head><body style="margin:0;background:#eef2f7;font-family:Arial,Helvetica,sans-serif;color:#24364a;padding:24px 12px"><table role="presentation" style="width:100%;max-width:620px;margin:auto;border-collapse:collapse;background:white;border:1px solid #e1e7ef"><tr><td style="padding:24px;background:#152e48;color:white;border-top:5px solid #f36a31"><div style="font-size:11px;letter-spacing:2px;color:#ffb48b;font-weight:700">DROPX · OPS PULSE</div><h1 style="font-size:23px;margin:12px 0 8px">Performance data updated</h1><div style="font-size:14px">${escapeHtml(label)}</div></td></tr><tr><td style="padding:24px"><p style="margin:0 0 16px;font-size:14px">Hello ${escapeHtml(recipient.name)},</p><div style="padding:14px;background:#e9f7ee;border-left:4px solid #23804c;color:#1b7145;font-size:14px;line-height:1.6;white-space:pre-line">${escapeHtml(message)}</div><p style="font-size:12px;color:#647085;line-height:1.7;margin:18px 0"><b>Updated locations in your scope · ${codes.length}</b><br>${codes.map(escapeHtml).join(' · ')}</p><a href="${escapeHtml(url)}" style="display:inline-block;background:#ed5d2a;color:white;text-decoration:none;border-radius:5px;padding:12px 18px;font-size:13px;font-weight:700">Open performance review →</a><p style="font-size:10px;line-height:1.6;color:#788294;margin:20px 0 0">One update notice per performance day. Daily updates reply in this month's thread. The date above is the performance date, not the email date.</p></td></tr></table></body></html>`;
    unique.set(email,{email,name:recipient.name,subject,html,text:['Ops Pulse · Performance data updated',label,'Hello '+recipient.name+',',message,'Updated locations in your scope: '+codes.join(', '),'Open performance review: '+url].join('\n\n'),scope:{stationIds:stations.map(s=>s.id),locations:codes.length}});
  }
  return [...unique.values()];
}
