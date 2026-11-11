export type BankMentionGroups={tl:string[];ct:string[];cluster:string[];aom:string[];managerEmails?:string[]};

export function bankMentionNumbers(groups:BankMentionGroups) {
  return [...new Set([...groups.tl,...groups.ct,...groups.cluster,...groups.aom])];
}

export function bankReminderText(header:string,rows:[string,string|number][],groups:BankMentionGroups) {
  const values=new Map(rows), tags=(numbers:string[])=>numbers.map(number=>"@"+number).join(" ");
  const fyi=[groups.ct.length?`CT ${tags(groups.ct)}`:"",groups.cluster.length?`Cluster Manager ${tags(groups.cluster)}`:"",groups.aom.length?`AOM ${tags(groups.aom)}`:""].filter(Boolean).join(" · ");
  const managerEmails=[...new Set((groups.managerEmails||[]).map(email=>email.trim().toLowerCase()).filter(email=>/^[^\s@]+@dropxlogistics\.com$/.test(email)))];
  const cc=[...new Set([...managerEmails,"ct@dropxlogistics.com","varun@dropxlogistics.com"])];
  return [
    `${tags(groups.tl)||"Station TL"}, your CMS person usually reports between ${values.get("CMS usually reports")}.`,
    header,
    `Pending: ${values.get("Due remittances")}`,
    values.has("Submitted today")?`Submitted today: ${values.get("Submitted today")}`:"",
    String(values.get("Action")||""),
    !values.has("Submitted today")?`CC: ${cc.join(", ")}; also copy your CTL and CRM.`:"",
    !values.has("Submitted today")&&!managerEmails.length?"Manager Workspace email is not mapped; CT, please confirm the @dropxlogistics.com CC address.":"",
    fyi?`FYI: ${fyi}`:"",
  ].filter(Boolean).join("\n");
}
