import { CodWorkspaceLoading } from "@/components/cod-workspace-loading";

export default function Loading() {
  return (
    <CodWorkspaceLoading
      title="Loading COD Reports"
      subtitle="Building pending COD queue and station-day analysis…"
    />
  );
}
