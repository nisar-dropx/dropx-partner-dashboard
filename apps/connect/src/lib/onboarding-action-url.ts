const cleanActionUrl = (value: unknown) => String(value ?? "").trim().replace(/[\]\)}>.,;:!?]+$/g, "");

export function amazonInvitationUrl(value: unknown) {
  const cleaned = cleanActionUrl(value);
  if (!cleaned) return null;
  try {
    const url = new URL(cleaned);
    if (url.protocol !== "https:" || url.hostname !== "logistics.amazon.in" || !url.pathname.startsWith("/account-management/invitation")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function idfyActionUrl(value: unknown) {
  const cleaned = cleanActionUrl(value);
  if (!cleaned) return null;
  try {
    const url = new URL(cleaned);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !(host === "idfy.com" || host.endsWith(".idfy.com"))) return null;
    return url.toString();
  } catch {
    return null;
  }
}
