/** A separate synthetic surface. This never grants a session or changes live authorization. */
export function isOpsDemoHost(host: string) {
  const name = host.toLowerCase().split(":")[0];
  return (
    name === "ops.dropxlogistics.com" ||
    name === "localhost" ||
    name === "127.0.0.1" ||
    (name.startsWith("dropx-ops-pulse-") && name.endsWith(".vercel.app"))
  );
}
export const opsDemoPaths = ["/demo", "/demo/last-mile", "/demo/dark-store"] as const;
export function isOpsDemoRequest(host: string, path: string, method: string) {
  return (
    isOpsDemoHost(host) && (opsDemoPaths as readonly string[]).includes(path) && ["GET", "HEAD"].includes(method)
  );
}
