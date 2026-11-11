/** This repository also deploys other DropX products. Only OpsPulse runs EDD cron. */
export function isEddCronHost(host: string) {
  const name=host.toLowerCase();
  if (process.env.NODE_ENV !== "production" && (name === "localhost" || name === "127.0.0.1")) return true;
  return name==="ops.dropxlogistics.com" || name==="dropx-ops-pulse.vercel.app" ||
    /^dropx-ops-pulse-[a-z0-9-]+\.vercel\.app$/.test(name);
}
