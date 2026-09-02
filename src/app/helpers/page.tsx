import { DynamicWorkforceCategoryPageContent } from "@/app/people/category/[code]/page";

type HelpersSearchParams = {
  edit?: string; error?: string; notice?: string; view?: string;
  full_name?: string; mobile_country_code?: string; mobile?: string; email?: string;
  date_of_join?: string; location_id?: string; designation?: string;
};

export default function HelpersPage({ searchParams }: { searchParams?: HelpersSearchParams }) {
  return (
    <DynamicWorkforceCategoryPageContent
      pageCodeOverride="workers"
      params={{ code: "helpers" }}
      returnPathOverride="/helpers"
      searchParams={searchParams}
    />
  );
}