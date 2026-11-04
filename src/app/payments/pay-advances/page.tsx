import { permanentRedirect } from "next/navigation";

export default function LegacyPayAdvancesPage() {
  permanentRedirect("/payments/advance-register");
}
