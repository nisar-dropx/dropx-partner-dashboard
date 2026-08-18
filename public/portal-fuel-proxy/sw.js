/**
 * Browser-side proxy for IOCL/BPCL portal APIs (operator ISP egress).
 */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith("/portal-fuel-proxy/")) return;
  const target = url.searchParams.get("url");
  if (!target || !/^https:\/\/(betaapi\.iocxtrapower\.com|api\.cep\.bpcl\.in|hellobpcl\.in)/i.test(target)) {
    event.respondWith(new Response("Invalid portal target", { status: 400 }));
    return;
  }
  const headers = new Headers(event.request.headers);
  headers.delete("host");
  event.respondWith(
    fetch(target, {
      method: event.request.method,
      headers,
      body: event.request.method === "GET" || event.request.method === "HEAD" ? undefined : event.request.body,
      redirect: "follow",
      credentials: "include"
    })
  );
});
