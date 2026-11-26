/** Ambient types for the Datoms alerts worker when imported from Next.js. */
export function runPoll(
  env: Record<string, unknown>,
  options?: { dryRun?: boolean }
): Promise<Record<string, unknown>>;

export function makeDatomsClient(env: Record<string, unknown>): unknown;

declare const _default: {
  fetch: (request: Request, env: Record<string, unknown>) => Promise<Response>;
  scheduled: (event: unknown, env: Record<string, unknown>, ctx: { waitUntil: (p: Promise<unknown>) => void }) => void;
};

export default _default;
