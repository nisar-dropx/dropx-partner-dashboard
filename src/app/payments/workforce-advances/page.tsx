import { permanentRedirect } from "next/navigation";

export default function LegacyWorkforceAdvancesPage() {
  permanentRedirect("/payments/advance-register");
}
