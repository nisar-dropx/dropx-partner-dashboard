import {resolvePeopleOperationalHierarchy,resolveManagerChainForPersonIds} from './people-operational-hierarchy-core.ts';
import {managerReviewChain} from './ops-pulse/review-policy.ts';
export function buildReviewMessages(snapshot,config,subjectTemplate){
const label=date=>new Date(date+'T12:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kolkata'});
const performanceLabel=label(snapshot.performanceDate),digestLabel=label(snapshot.digestDate);
const month=new Date(snapshot.performanceDate+'T12:00:00Z').toLocaleDateString('en-GB',{month:'long',year:'numeric',timeZone:'Asia/Kolkata'}).split(' ');
const subject=subjectTemplate.replace('{{month}}',month[0]).replace('{{year}}',month[1]);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// This digest is for the existing last-mile review workflow. Q-commerce has
// its own forthcoming workflow, and must not create false pending stages here.
const excludedModels = new Set(['NOW', 'AMAZONNOW', 'QC', 'QCOMMERCE', 'QUICKCOMMERCE', 'ODH', 'MDH']);
const stations = snapshot.stations.filter(s => {
  const model = String(s.model).toUpperCase();
  return config.included_models.includes(model) && !excludedModels.has(model);
});
const includedCodes = new Set(stations.map(s => s.station_code));
const recipients = snapshot.recipients.filter(r=>config.recipient_role_codes.includes(r.designation_code)&&String(r.email).endsWith('@'+config.email_domain)).map(r => ({...r, station_codes:r.station_codes.filter(code => includedCodes.has(code))})).filter(r => r.station_codes.length);
const hierarchy = resolvePeopleOperationalHierarchy(stations.map(s => s.id), snapshot.assignments, snapshot.relationships);
const rows = stations.map(station => {
  const review = snapshot.reviews.find(r => r.station_id === station.id);
  const existingSteps = snapshot.steps.filter(s => s.review_id === review?.id).sort((a,b) => a.step_order-b.step_order);
  const h = hierarchy.get(station.id);
  let chain = managerReviewChain(h?.managerReportingChain.length ? h.managerReportingChain : h?.primaryReportingChain ?? []);
  if (!chain.length) {
    const scopedUserIds = snapshot.recipients.filter(r => r.station_codes.includes(station.station_code)).map(r => r.id);
    const peopleIds = snapshot.links.filter(l => scopedUserIds.includes(l.user_id)).map(l => l.person_id);
    chain = managerReviewChain(resolveManagerChainForPersonIds(peopleIds, snapshot.assignments, snapshot.relationships));
  }
  const steps = existingSteps.length ? existingSteps : chain.map((p,index) => ({reviewer_name:p.name,reviewer_role:p.role,status:'pending',step_order:index+1}));
  const pending = steps.filter(s => s.status === 'pending');
  const done = steps.filter(s => s.status === 'completed');
  const skipped = steps.filter(s => s.status === 'skipped');
  return {...station, steps, pending, done, skipped, status:review?.status === 'closed' && !pending.length ? 'completed' : review ? 'in_progress' : 'not_started', routingMissing:!steps.length};
});
const order = {not_started:0,in_progress:1,completed:2};
rows.sort((a,b) => order[a.status]-order[b.status] || a.station_code.localeCompare(b.station_code));
const roleLabel = value => /cluster/i.test(value) ? 'Cluster' : /area/i.test(value) ? 'AOM' : /national/i.test(value) ? 'National' : value;
function chip(text, color='red') {
  const colors = {red:['#fff1f2','#b42332'],green:['#e9f7ee','#1b7145'],amber:['#fff5db','#875900'],gray:['#f1f3f6','#637083']};
  const [bg,fg] = colors[color];
  return `<span style="display:inline-block;background:${bg};color:${fg};font-size:11px;font-weight:700;padding:4px 7px;border-radius:5px;margin:2px 3px 2px 0;white-space:nowrap">${esc(text)}</span>`;
}
function renderRow(row) {
  const pendingText = row.routingMissing ? '<b style="color:#875900">Reporting route not configured</b>' : row.pending.length ? row.pending.map((s,index) => `<div style="margin:3px 0;${index === 0 ? 'font-weight:700;color:#b42332' : 'color:#647085'}">${index === 0 ? 'Next: ' : ''}${esc(s.proxy_reviewer_name || s.reviewer_name)} <span style="font-size:11px">· ${esc(roleLabel(s.reviewer_role))}</span></div>`).join('') : '<span style="color:#1b7145">No review stage pending</span>';
  const time = value => value ? new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) + ' IST' : '';
  const stages = row.steps.map(s => `<div>${chip(`${roleLabel(s.reviewer_role)} ${s.status === 'completed' ? '✓' : s.status === 'skipped' ? 'Skipped' : 'Pending'}`, s.status === 'completed' ? 'green' : s.status === 'skipped' ? 'amber' : 'red')}${s.status === 'completed' ? `<div style="font-size:10px;color:#1b7145;margin:1px 0 7px">Reviewed by ${esc(s.proxy_reviewer_name || s.reviewer_name)}${s.proxy_reviewer_name ? `<br>on behalf of ${esc(s.reviewer_name)} · Proxy review` : ''}${s.completed_at ? `<br>${esc(time(s.completed_at))}` : ''}</div>` : s.status === 'pending' && s.proxy_reviewer_name ? `<div style="font-size:10px;color:#875900">Proxy assigned: ${esc(s.proxy_reviewer_name)}<br>on behalf of ${esc(s.reviewer_name)} · Not yet reviewed</div>` : ''}</div>`).join('');
  return `<tr><td style="padding:13px 12px;border-bottom:1px solid #e9edf2;vertical-align:top;width:24%"><b style="color:#172d47;font-size:14px">${esc(row.station_code)}</b><div style="font-size:11px;color:#788294;margin-top:3px">${esc(row.station_name)} · ${esc(row.model)}</div>${chip(row.status === 'completed' ? 'Complete' : row.status === 'in_progress' ? 'In progress' : 'Not started',row.status==='completed'?'green':row.status==='in_progress'?'amber':'red')}</td><td style="padding:10px 12px;border-bottom:1px solid #e9edf2;vertical-align:top;font-size:12px">${pendingText}</td><td style="padding:10px 12px;border-bottom:1px solid #e9edf2;vertical-align:top;width:29%">${stages}<div style="font-size:11px;color:#788294;margin-top:4px">${row.done.length} reviewed${row.skipped.length ? ` · ${row.skipped.length} skipped` : ''} · ${row.routingMissing ? 'Route missing' : `${row.pending.length} layer${row.pending.length===1?'':'s'} pending`}</div></td></tr>`;
}
function renderEmail(recipient) {
  const scoped = rows.filter(r => recipient.station_codes.includes(r.station_code));
  const pending = scoped.filter(r => r.status !== 'completed');
  const completed = scoped.filter(r => r.status === 'completed');
  const stageCount = pending.reduce((n,r) => n+r.pending.length,0);
  const people = new Map();
  pending.forEach(r => r.pending.forEach(s => {const key=`${s.proxy_reviewer_name || s.reviewer_name} · ${roleLabel(s.reviewer_role)}`; people.set(key,(people.get(key)||0)+1);}));
  const panel = (title,items) => `<h2 style="font-size:15px;margin:24px 0 10px;color:${title.startsWith('Completed')?'#1b7145':'#b42332'}">${title} · ${items.length}</h2>${items.length ? `<table role="table" style="border-collapse:collapse;width:100%;text-align:left;background:#fff"><thead><tr style="background:#f4f6f9;color:#657184;font-size:10px;text-transform:uppercase"><th style="padding:10px 12px">Location</th><th style="padding:10px 12px">${title.startsWith('Completed')?'Review outcome':'Pending with · next person first'}</th><th style="padding:10px 12px">Review levels</th></tr></thead><tbody>${items.map(renderRow).join('')}</tbody></table>` : '<p style="font-size:12px;color:#788294;padding:12px;background:#f4f6f9">No locations fully completed at this snapshot.</p>'}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ops Pulse · Daily review status</title></head><body style="margin:0;padding:24px 10px;background:#eef2f7;font-family:Arial,Helvetica,sans-serif;color:#24364a"><div style="display:none;max-height:0;overflow:hidden">${pending.length} locations pending · ${stageCount} review layers pending · performance day ${performanceLabel}</div><table role="presentation" style="width:100%;max-width:900px;margin:auto;border-collapse:collapse;background:white;border:1px solid #e1e7ef"><tr><td style="background:#152e48;color:#fff;padding:24px 26px;border-top:5px solid #f36a31"><div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#ffb48b">DROPX · OPS PULSE</div><h1 style="font-size:24px;margin:9px 0 6px">Daily review status</h1><div style="font-size:12px;color:#d3deea">${digestLabel} · Performance day: ${performanceLabel}</div></td></tr><tr><td style="padding:20px 26px"><div style="font-size:12px;margin-bottom:15px"><b>${esc(recipient.full_name)}</b> · ${esc(recipient.designation)}<br><span style="color:#788294">${recipient.all_locations ? 'All operational locations' : 'Your mapped locations'} · ${scoped.length} locations</span></div><table role="presentation" style="width:100%;border-spacing:5px 0"><tr>${[[pending.length,'Locations pending','#b42332','#fff1f2'],[stageCount,'Review layers pending','#875900','#fff5db'],[completed.length,'Locations complete','#1b7145','#e9f7ee']].map(([count,label,fg,bg])=>`<td style="background:${bg};padding:14px;color:${fg};width:33%;border-radius:6px"><b style="font-size:27px">${count}</b><div style="font-size:11px;margin-top:4px">${label}</div></td>`).join('')}</tr></table><div style="margin:18px 0 8px"><b style="font-size:12px">Pending reviewers</b><div style="margin-top:5px">${[...people.entries()].sort((a,b)=>b[1]-a[1]).map(([name,count])=>chip(`${name} · ${count}`)).join('')}</div></div>${panel('Action needed',pending)}${panel('Completed locations',completed)}${config.manager_reminder?`<p style="padding:12px;background:#fff5eb;color:#875228;font-size:12px;line-height:1.5">${esc(config.manager_reminder)}</p>`:''}<div style="margin:22px 0 15px"><a href="https://ops.dropxlogistics.com/performance/review-status?from=${snapshot.performanceDate}&amp;to=${snapshot.performanceDate}" style="background:#ed5d2a;color:white;text-decoration:none;padding:12px 18px;font-size:12px;font-weight:700;border-radius:5px;display:inline-block">Open review status →</a></div><p style="font-size:10px;line-height:1.6;color:#788294;margin-bottom:0">Status snapshot · ${digestLabel}. Reviews follow the previous performance day. Only configured review stages count; skipped stages are not marked as reviewed. Program Manager and Owner receive oversight summaries.</p></td></tr></table></body></html>`;
  return {html, recipient, counts:{locations:scoped.length,pending:pending.length,complete:completed.length,pendingStages:stageCount},routingMissing:scoped.filter(r=>r.routingMissing).map(r=>r.station_code)};
}

return recipients.map(recipient=>{const result=renderEmail(recipient);const scoped=rows.filter(r=>recipient.station_codes.includes(r.station_code));return {email:recipient.email,name:recipient.full_name,subject,html:result.html,text:['Ops Pulse daily review status','Report date: '+digestLabel,'Performance day: '+performanceLabel,String(config.manager_reminder||''),...scoped.map(row=>row.station_code+' · '+row.station_name+' · '+row.status+' | '+row.steps.map(s=>s.reviewer_role+': '+s.status+' · '+(s.proxy_reviewer_name?s.proxy_reviewer_name+' (proxy for '+s.reviewer_name+')':s.reviewer_name)).join('; ')),'https://ops.dropxlogistics.com/performance/review-status?from='+snapshot.performanceDate+'&to='+snapshot.performanceDate].join('\n'),scope:{stationIds:scoped.map(r=>r.id),...result.counts}};}).filter(m=>config.send_zero_cases||m.scope.pending>0);
}
