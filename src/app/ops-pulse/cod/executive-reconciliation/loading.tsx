import { CodWorkspaceLoading } from "@/components/cod-workspace-loading";

export default function Loading() {
  return (
    <CodWorkspaceLoading
      title="Loading Executive Reconciliation"
      subtitle="Fetching cash sheet, driver validation, and remittance status…"
    />
  );
}
