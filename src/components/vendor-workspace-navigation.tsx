import Link from "next/link";

export type VendorSection = "overview" | "register" | "van" | "security" | "housekeeping" | "pest" | "contracts" | "master";

const vendorSections: { key: VendorSection; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "register", label: "Vendor register" },
  { key: "van", label: "Van vendors" },
  { key: "security", label: "Security guards" },
  { key: "housekeeping", label: "Housekeeping" },
  { key: "pest", label: "Pest control" },
  { key: "contracts", label: "Contracts & payouts" },
  { key: "master", label: "Service master" }
];

export function VendorWorkspaceNavigation({ active }: { active: VendorSection }) {
  return (
    <nav className="performance-tabs vendor-workspace-tabs" aria-label="Vendor lifecycle sections">
      {vendorSections.map((section) => (
        <Link className={active === section.key ? "active" : ""} href={`/vendors?section=${section.key}`} key={section.key}>
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
