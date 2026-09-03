import { WorkForceRegisterCategoryPage, type WorkForceRegisterSearchParams } from "@/components/ops-work-force-register-page";

export default function WorkForceRegisterPage({ searchParams }: { searchParams?: WorkForceRegisterSearchParams }) {
  return <WorkForceRegisterCategoryPage category="workforce" searchParams={searchParams} />;
}
