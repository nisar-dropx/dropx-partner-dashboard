import { CodWorkspaceLoading } from "@/components/cod-workspace-loading";

export default function Loading() {
  return (
    <CodWorkspaceLoading
      title="Loading station CIA detail"
      subtitle="Fetching pending drivers and remittance clearance for this station…"
    />
  );
}
