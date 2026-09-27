// No credentials or provider pagination URLs are returned to the browser.
export async function templateGraphRequest(version: string, accountId: string, token: string, options: {payload?: unknown; after?: string} = {}, fetcher: typeof fetch = fetch) {
  if (!/^v\d+\.\d+$/.test(version) || !/^\d+$/.test(accountId)) throw new Error("The sender's Meta account configuration is invalid.");
  const url = new URL(`https://graph.facebook.com/${version}/${accountId}/message_templates`);
  if (!options.payload) {
    url.searchParams.set("fields", "id,name,status,language,category,components,rejected_reason");
    url.searchParams.set("limit", "100");
    if (options.after) url.searchParams.set("after",options.after);
  }
  const response = await fetcher(url, {
    method: options.payload ? "POST" : "GET",
    headers: {Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    ...(options.payload ? {body:JSON.stringify(options.payload)} : {}),
    cache:"no-store", signal:AbortSignal.timeout(20000)
  });
  const data = await response.json() as {
    id?: string; status?: string; category?: string;
    data?: Array<Record<string, unknown>>;
    paging?: {next?: string; cursors?: {after?: string}};
    error?: {message?: string; error_user_msg?: string; code?: number};
  };
  if (!response.ok || data.error) {
    const message = data.error?.error_user_msg || data.error?.message || "Meta could not complete this request.";
    throw new Error(message.replaceAll(token, "[redacted]").slice(0,500));
  }
  return data;
}
export async function listMetaTemplates(version: string, accountId: string, token: string, fetcher: typeof fetch = fetch) {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let after: string | undefined;
  do {
    const page = await templateGraphRequest(version,accountId,token,{after},fetcher);
    if (!Array.isArray(page.data) || page.data.some(row => !row.id || !row.name || !row.status)) throw new Error("Meta returned an incomplete template list. Saved templates were not changed.");
    rows.push(...page.data);
    const next = page.paging?.next ? page.paging?.cursors?.after : undefined;
    if (!next) return rows;
    if (seen.has(next) || rows.length >= 10000) throw new Error("Template refresh was incomplete. Please try again.");
    seen.add(next); after = next;
  } while (after);
  return rows;
}
