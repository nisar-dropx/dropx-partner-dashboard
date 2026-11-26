declare module "*workers/datoms-alerts/src/index.mjs" {
  export function runPoll(
    env: Record<string, unknown>,
    options?: { dryRun?: boolean }
  ): Promise<Record<string, unknown>>;

  export function makeDatomsClient(env: Record<string, unknown>): unknown;

  const worker: {
    fetch: (request: Request, env: Record<string, unknown>) => Promise<Response>;
    scheduled: (
      event: unknown,
      env: Record<string, unknown>,
      ctx: { waitUntil: (promise: Promise<unknown>) => void }
    ) => void;
  };
  export default worker;
}
