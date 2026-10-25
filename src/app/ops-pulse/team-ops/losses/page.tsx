import { redirect } from "next/navigation";
import { defaultLossFilter } from "@/lib/ops-pulse/loss-recovery-controls";
export const dynamic = "force-dynamic";
export default function LossesPage() {
 redirect(defaultLossFilter()==="recoverable" ? "/team-ops/losses/recovery" : "/team-ops/losses/nl?view=live");
}
