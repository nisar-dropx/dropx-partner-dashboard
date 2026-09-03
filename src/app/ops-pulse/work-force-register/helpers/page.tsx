import { WorkForceRegisterCategoryPage, type WorkForceRegisterSearchParams } from "@/components/ops-work-force-register-page";

export default function HelpersRegisterPage({ searchParams }: { searchParams?: WorkForceRegisterSearchParams }) {
  return <WorkForceRegisterCategoryPage category="helpers" searchParams={searchParams} />;
}
