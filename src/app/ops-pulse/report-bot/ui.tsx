import Link from "next/link";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Circle } from "lucide-react";
import { CopyButton } from "@/components/report-bot-controls";
import { aiKeyConfigured, aiKeyName, reportBotDb, type ReportBotSettings } from "@/lib/report-bot/settings";
import s from "./report-bot.module.css";

// Shared building blocks for the Report Bot pages (server components only).

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

export const SETUP_HREF = "/report-bot/setup";
export const WORKER_FRESH_MS = 3 * 60 * 1000;

export const STATUS: Record<string, [string, Tone]> = {
  queued: ["Checking", "info"],
  blocked: ["On hold", "warn"],
  awaiting_approval: ["Waiting for review", "warn"],
  queued_to_send: ["Sending", "info"],
  sent: ["Reply sent", "good"],
  ignored: ["Not a report", "neutral"],
  skipped: ["Skipped", "neutral"],
  rejected: ["Not sent", "neutral"],
  failed: ["Failed", "bad"],
  pending: ["Waiting", "neutral"],
  overdue: ["Overdue", "bad"],
  received: ["Received", "good"],
  missed: ["Missed", "bad"],
  cancelled: ["Cancelled", "neutral"]
};

export const VERDICT: Record<string, [string, Tone]> = {
  pass: ["Looks good", "good"],
  fail: ["Needs correction", "bad"],
  needs_review: ["Unclear", "warn"],
  not_report: ["Not a report", "neutral"]
};

export function Badge({ tone, children, className = "" }: { tone: Tone; children: ReactNode; className?: string }) {
  return <span className={`${s.badge} ${s[tone]} ${className}`}>{children}</span>;
}

export function StatusBadge({ value }: { value: string }) {
  const [label, tone] = STATUS[value] ?? [value, "neutral" as Tone];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Field({ label, hint, children, className = "" }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`${s.field} ${className}`}>
      <span className={s.label}>{label}</span>
      {children}
      {hint ? <span className={s.hint}>{hint}</span> : null}
    </label>
  );
}

export function Toggle({ name, label, hint, defaultChecked, disabled }: { name: string; label: string; hint?: string; defaultChecked?: boolean; disabled?: boolean }) {
  return (
    <label className={s.switch}>
      <input type="checkbox" role="switch" name={name} defaultChecked={defaultChecked} disabled={disabled} />
      <span>{label}{hint ? <small>{hint}</small> : null}</span>
    </label>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className={s.empty}>{icon}<strong>{title}</strong>{children ? <span>{children}</span> : null}</div>;
}

export function Card({ id, title, icon, description, action, children, flush }: { id?: string; title: string; icon?: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={s.card} id={id}>
      <div className={s.cardHead}>
        <div><h2>{icon}{title}</h2>{description ? <p>{description}</p> : null}</div>
        {action}
      </div>
      {flush ? children : <div className={s.cardBody}>{children}</div>}
    </section>
  );
}

export function when(value: string | null | undefined, timeZone: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function sender(row: { sender_name: string | null; sender_jid: string | null }) {
  return row.sender_name || (row.sender_jid ? `+${row.sender_jid.split("@")[0].split(":")[0]}` : "Unknown sender");
}

export function readFlash() {
  const raw = cookies().get("dropx_report_bot_flash")?.value;
  if (!raw) return {} as { error?: string; notice?: string; token?: string };
  try {
    return JSON.parse(raw) as { error?: string; notice?: string; token?: string };
  } catch {
    return {};
  }
}

export function FlashMessage() {
  const flash = readFlash();
  if (!flash.error && !flash.notice) return null;
  return (
    <div className={`${s.flash} ${flash.error ? s.flashError : s.flashSuccess}`} role={flash.error ? "alert" : "status"}>
      {flash.error ? <AlertTriangle size={18} aria-hidden /> : <CheckCircle2 size={18} aria-hidden />}
      <div>
        <strong>{flash.error ? "That didn't work" : "Done"}</strong>
        {flash.error ?? flash.notice}
        {flash.token ? (
          <div className={s.tokenBox}>
            <code>{flash.token}</code>
            <CopyButton value={flash.token} className={`${s.button} ${s.small}`} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function workerIsOnline(settings: ReportBotSettings) {
  return Boolean(settings.last_worker_seen_at) && Date.now() - new Date(settings.last_worker_seen_at!).getTime() < WORKER_FRESH_MS;
}

export type SetupStep = { done: boolean; text: string; href: string };

/** Company-wide setup progress, shared by the setup page and the main page banner. */
export async function loadSetupSteps(settings: ReportBotSettings): Promise<SetupStep[]> {
  const db = reportBotDb();
  const [groups, schedules] = await Promise.all([
    db.from("report_bot_groups").select("id", { head: true, count: "exact" }).eq("company_id", settings.company_id).eq("is_enabled", true),
    db.from("report_bot_schedules").select("id", { head: true, count: "exact" }).eq("company_id", settings.company_id).eq("is_active", true)
  ]);
  return [
    { done: Boolean(settings.worker_url && settings.worker_token_hash && workerIsOnline(settings)), text: "Deploy the worker (Render, free)", href: `${SETUP_HREF}#worker` },
    { done: settings.connection_state === "open", text: "Link a WhatsApp number", href: `${SETUP_HREF}#whatsapp` },
    { done: (groups.count ?? 0) > 0, text: "Turn on a report group", href: "/report-bot?tab=groups" },
    { done: (schedules.count ?? 0) > 0, text: "Add a report type and a schedule", href: "/report-bot?tab=reports" },
    { done: aiKeyConfigured(settings.ai_provider), text: `Add ${aiKeyName(settings.ai_provider)} in Vercel`, href: `${SETUP_HREF}#ai` },
    { done: settings.mode !== "off", text: "Switch the bot to Listen only", href: `${SETUP_HREF}#mode` }
  ];
}

export function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  const done = steps.filter((step) => step.done).length;
  return (
    <section className={s.setup} aria-labelledby="setup-title">
      <div className={s.setupHead}>
        <h2 id="setup-title">{done === steps.length ? "Setup complete" : "Finish setting up"}</h2>
        <span>{done} of {steps.length} done</span>
      </div>
      <div className={s.progress} aria-hidden><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ol className={s.steps}>
        {steps.map((step) => (
          <li key={step.text} className={`${s.step} ${step.done ? s.done : ""}`}>
            {step.done ? <CheckCircle2 size={18} className={s.stepIcon} aria-label="Done" /> : <Circle size={18} className={s.stepIcon} aria-label="To do" />}
            <span className={s.stepText}>{step.text}</span>
            {step.done ? null : <Link className={s.stepLink} href={step.href}>Open<ChevronRight size={14} aria-hidden /></Link>}
          </li>
        ))}
      </ol>
    </section>
  );
}
