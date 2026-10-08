import { redirect } from "next/navigation";

/** Team Ops → Losses opens on the NL Loss sub-page. */
export default function LossesPage() {
  redirect("/team-ops/losses/nl");
}
