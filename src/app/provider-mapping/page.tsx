import { ProviderMappingPageContent } from "@/components/provider-mapping-page-content";

export default function ProviderMappingPage({searchParams}: {searchParams?: {q?:string}}) {
  return <ProviderMappingPageContent initialQuery={searchParams?.q} />;
}
