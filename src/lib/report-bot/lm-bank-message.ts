export type BankMentionGroups={tl:string[];ct:string[];cluster:string[];aom:string[]};

export function bankReminderText(header:string,rows:[string,string|number][],groups:BankMentionGroups) {
  const values=new Map(rows), tags=(numbers:string[])=>numbers.map(number=>"@"+number).join(" ");
  const fyi=[groups.ct.length?`CT ${tags(groups.ct)}`:"",groups.cluster.length?`Cluster Manager ${tags(groups.cluster)}`:"",groups.aom.length?`AOM ${tags(groups.aom)}`:""].filter(Boolean).join(" · ");
  return [
    `${tags(groups.tl)||"Station TL"}, your CMS person usually reports between ${values.get("CMS usually reports")}.`,
    header,
    `Pending: ${values.get("Due remittances")}`,
    values.has("Submitted today")?`Submitted today: ${values.get("Submitted today")}`:"",
    String(values.get("Action")||""),
    fyi?`FYI: ${fyi}`:"",
  ].filter(Boolean).join("\n");
}
