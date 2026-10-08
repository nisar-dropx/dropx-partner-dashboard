import { AppShell } from "@/components/app-shell";

/** Shell lives in the layout so switching Losses tabs / stations only re-renders the content. */
export default function LossesLayout({ children }: { children: React.ReactNode }) {
  return <AppShell active="Team Ops" pageCode="ops_losses">{children}</AppShell>;
}
