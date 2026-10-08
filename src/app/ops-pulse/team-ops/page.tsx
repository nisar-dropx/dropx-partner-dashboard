import { redirect } from "next/navigation";

/** /team-ops currently holds Losses only. */
export default function TeamOpsPage() {
  redirect("/team-ops/losses/nl");
}
