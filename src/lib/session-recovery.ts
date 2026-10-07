function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}

/** Standalone recovery works even when the application cannot authenticate. */
export function sessionRecoveryHtml(path: string, product: string) {
  const safePath = path.startsWith("/") && !path.startsWith("//") && !/[\\\r\n]/.test(path) ? path : "/";
  const retry = escapeHtml(safePath);
  const login = escapeHtml(`/login?next=${encodeURIComponent(safePath)}`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reconnect · ${escapeHtml(product)}</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7f8;color:#19323b;font:16px/1.6 system-ui,sans-serif;padding:24px}main{max-width:480px;width:100%;padding:36px;background:white;border:1px solid #dde7e9;border-radius:20px;box-shadow:0 16px 48px #19323b0d}.brand{font-weight:800;color:#137e76;font-size:14px}h1{font-size:26px;line-height:1.25;margin:20px 0 12px}p{color:#526670}nav{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}a{padding:11px 18px;border:1px solid #cad8dc;border-radius:10px;color:#19323b;text-decoration:none;font-weight:650}a:first-child{background:#137e76;color:white;border-color:#137e76}a:focus-visible{outline:3px solid #f39252;outline-offset:3px}small{display:block;color:#526670;margin-top:24px}
  </style></head><body><main><div class="brand">${escapeHtml(product)}</div><h1>Let’s reconnect your session</h1><p>The sign-in service took too long to respond. Try again to continue, or open sign-in if the problem continues.</p><nav aria-label="Session recovery"><a href="${retry}">Try again</a><a href="${login}">Open sign-in</a></nav><small>No need to clear your browser data.</small></main></body></html>`;
}
