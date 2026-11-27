import { redirect } from "next/navigation";

/** Legacy cold-chain route — DATOMS Alerts is the canonical surface. */
export default function DarkStoreColdChainRedirect() {
  redirect("/operations/datoms/alerts");
}
