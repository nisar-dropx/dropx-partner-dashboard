import { DynamicWorkforceCategoryPageContent } from "@/app/people/category/[code]/page";
import { RegisterNavigation, type WorkForceRegisterSearchParams } from "@/components/ops-work-force-register-page";

export default function HelpersRegisterPage({ searchParams }: { searchParams?: WorkForceRegisterSearchParams }) {
  return (
    <DynamicWorkforceCategoryPageContent
      pageCodeOverride="contractors"
      params={{ code: "helpers" }}
      registerNavigation={<RegisterNavigation active="helpers" />}
      returnPathOverride="/work-force-register/helpers"
      searchParams={searchParams}
    />
  );
}
