import { WorkForceRegisterCategoryPage, type WorkForceRegisterSearchParams } from "@/components/ops-work-force-register-page";

export default function VendorsRegisterPage({ searchParams }: { searchParams?: WorkForceRegisterSearchParams }) {
  return <WorkForceRegisterCategoryPage category="vendors" searchParams={searchParams} />;
}
