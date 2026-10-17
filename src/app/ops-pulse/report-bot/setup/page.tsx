import Link from "next/link";
import { ArrowLeft, Bot, Download, FileText, Info, Send, Server, Settings2, Smartphone, Sparkles } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { ActionButton, CopyButton } from "@/components/report-bot-controls";
import { ReportBotConnection } from "@/components/report-bot-connection";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { REPORT_BOT_PAGE } from "@/lib/report-bot/access";
import { aiKeyName, ensureWorkerToken, loadReportBotSettings, portalPublicUrl, type ReportBotSettings } from "@/lib/report-bot/settings";
import { connectWhatsApp, disconnectWhatsApp, rotateWorkerToken, saveBotSettings, saveWorkerUrl } from "../actions";
import s from "../report-bot.module.css";
import { Badge, Card, Field, FlashMessage, MigrationWarning, loadSetupSteps, SetupChecklist, Toggle, when, workerIsOnline } from "../ui";

export const dynamic = "force-dynamic";

export default async function ReportBotSetupPage() {
  const authorization = await requirePagePermission(REPORT_BOT_PAGE, "access");
  const companyId = requireCompanyId(authorization);
  const canEdit = hasPermission(authorization, REPORT_BOT_PAGE, "edit");
  let settings: ReportBotSettings;
  try {
    settings = await loadReportBotSettings(companyId);
    if (canEdit) settings = await ensureWorkerToken(settings);
  } catch (error) {
    return (
      <AppShell active="Report Bot setup" pageCode={REPORT_BOT_PAGE}>
        <div className={s.page}>
          <div className={`${s.flash} ${s.flashError}`} role="alert">
            <Info size={18} aria-hidden />
            <div><strong>Report Bot isn&apos;t set up in the database yet</strong>{error instanceof Error ? error.message : "Unavailable"}. Apply the Report Bot migrations, then reload.</div>
          </div>
        </div>
      </AppShell>
    );
  }
  const steps = await loadSetupSteps(settings);

  return (
    <AppShell active="Report Bot setup" pageCode={REPORT_BOT_PAGE}>
      <div className={s.page}>
        <header className={s.hero}>
          <div>
            <span className={s.eyebrow}><Settings2 size={13} aria-hidden /> Settings · Dark Store</span>
            <h1>Report Bot setup</h1>
            <p>Connect the worker and WhatsApp, choose the AI, and decide how replies are sent.</p>
          </div>
          <Link className={s.button} href="/report-bot"><ArrowLeft size={15} aria-hidden />Open Report Bot</Link>
        </header>
        <SetupChecklist steps={steps} />
        {await MigrationWarning()}
        <FlashMessage />
        <div className={s.connectSteps}>
          <WorkerCard settings={settings} canEdit={canEdit} />
          <WhatsAppCard settings={settings} canEdit={canEdit} />
          <SettingsForm settings={settings} canEdit={canEdit} />
        </div>
      </div>
    </AppShell>
  );
}

function WorkerCard({ settings, canEdit }: { settings: ReportBotSettings; canEdit: boolean }) {
  const online = workerIsOnline(settings);
  const token = settings.worker_token ?? "";
  const portal = portalPublicUrl();
  const localCommands = [
    "cd workers\\whatsapp-report-bot",
    "npm ci",
    `$env:PORTAL_URL = "${portal}"`,
    `$env:WORKER_TOKEN = "${token}"`,
    "node server.mjs",
    "",
    "# In a second window, give it a public https address, then paste that address below:",
    "cloudflared tunnel --url http://localhost:8090"
  ].join("\n");
  // The worker is deployed from its own private repository in the company GitHub organisation.
  const renderSteps = [
    "Sign in at render.com with GitHub and allow Render access to DROPX-LOGISTICS → Report-bot-worker.",
    "New → Blueprint → choose DROPX-LOGISTICS/Report-bot-worker. Render reads its render.yaml and sets up the free service.",
    "Paste the token above as WORKER_TOKEN when asked, then click Apply."
  ];
  const railwaySteps = [
    "Sign in at railway.com with GitHub.",
    "New Project → Deploy from GitHub repo → DROPX-LOGISTICS/Report-bot-worker.",
    "Variables → add WORKER_TOKEN with the token above.",
    "Settings → Networking → Generate Domain."
  ];
  return (
    <Card
      id="worker"
      title="Worker"
      icon={<span className={`${s.stepNumber} ${online ? s.stepNumberDone : ""}`}>1</span>}
      description="A small always-on program that keeps WhatsApp connected and passes photos and messages to this portal. The portal can't hold a WhatsApp connection itself (it only runs short jobs), so the worker runs on a small host such as Render's free plan."
      action={online ? <Badge tone="good">Online</Badge> : <Badge tone={settings.last_worker_seen_at ? "warn" : "neutral"}>{settings.last_worker_seen_at ? `Last seen ${when(settings.last_worker_seen_at, settings.timezone)}` : "Not started"}</Badge>}
    >
      <div className={s.session}>
        {canEdit ? (
          <>
            <div className={s.inlineForm} style={{ alignItems: "center" }}>
              <div className={s.field} style={{ flex: 1 }}>
                <span className={s.label}>Worker settings</span>
                <span className={s.hint}>The portal address and the worker&apos;s private token, ready to use.</span>
              </div>
              <a className={`${s.button} ${s.primary}`} href="/api/report-bot/worker-env" download><Download size={15} aria-hidden />Download .env</a>
            </div>
            <details className={s.item}>
              <summary><span className={s.itemTitle}>Show token</span></summary>
              <div className={s.itemBody}>
                <div className={s.tokenBox} style={{ marginTop: 0 }}>
                  <code>{token}</code>
                  <CopyButton value={token} className={`${s.button} ${s.small}`} />
                </div>
                <p className={s.hint} style={{ marginTop: 8 }}>Created {when(settings.worker_token_created_at, settings.timezone)}. Anyone with this token can act as your bot&apos;s worker, so keep it private.</p>
              </div>
            </details>
            <details className={s.item} open={!settings.last_worker_seen_at}>
              <summary><span className={s.itemTitle}>Deploy on Render — free</span></summary>
              <div className={s.itemBody}>
                <p className={s.hint}>Render builds and runs the worker from the company&apos;s private Report-bot-worker repository in its own cloud, so nothing is installed on your computer. One-time, about three minutes:</p>
                <ol className={s.checks} style={{ listStyle: "decimal", paddingLeft: 20, margin: "10px 0" }}>
                  {renderSteps.map((step) => <li key={step} style={{ display: "list-item" }}>{step}</li>)}
                </ol>
                <p className={s.hint}>Render&apos;s free plan sleeps a service after 15 minutes without visits; this portal pings the worker every minute so it stays awake, and if Render restarts it anyway it reconnects to WhatsApp on its own (the login is stored here). Step 1 turns Online by itself within a minute of the deploy finishing.</p>
              </div>
            </details>
            <details className={s.item}>
              <summary><span className={s.itemTitle}>Deploy on Railway — about $5/month, never sleeps</span></summary>
              <div className={s.itemBody}>
                <p className={s.hint}>Use this if the free option ever proves unreliable. One-time, about five minutes:</p>
                <ol className={s.checks} style={{ listStyle: "decimal", paddingLeft: 20, margin: "10px 0" }}>
                  {railwaySteps.map((step) => <li key={step} style={{ display: "list-item" }}>{step}</li>)}
                </ol>
              </div>
            </details>
            <details className={s.item}>
              <summary><span className={s.itemTitle}>Quick test on this computer (no Docker)</span></summary>
              <div className={s.itemBody}>
                <p className={s.hint}>Run in PowerShell from the project folder. It only works while both windows stay open, and the tunnel address changes each restart.</p>
                <pre className={s.code}>{localCommands}</pre>
                <CopyButton value={localCommands} className={`${s.button} ${s.small}`} />
              </div>
            </details>
            <div className={s.divider} />
          </>
        ) : null}
        <form action={saveWorkerUrl} className={s.inlineForm}>
          <Field label="Worker address" hint="Filled in automatically by a worker on Railway, Render or Fly. Only type it for a local test with a tunnel.">
            <input className={s.input} name="worker_url" defaultValue={settings.worker_url ?? ""} placeholder="https://your-worker.up.railway.app" required disabled={!canEdit} />
          </Field>
          {canEdit ? <ActionButton className={`${s.button} ${s.primary}`}>Save address</ActionButton> : null}
        </form>
        {canEdit ? (
          <form action={rotateWorkerToken} className={s.formActions} style={{ justifyContent: "flex-start" }}>
            <ActionButton className={`${s.button} ${s.small} ${s.ghost}`} confirm="Replace the token? The running worker stops working until it gets the new one.">Replace token</ActionButton>
            <span className={s.hint}>Only if the token leaked. The running worker must be restarted with the new one.</span>
          </form>
        ) : null}
      </div>
    </Card>
  );
}

function WhatsAppCard({ settings, canEdit }: { settings: ReportBotSettings; canEdit: boolean }) {
  const workerReady = Boolean(settings.worker_url && settings.worker_token_hash);
  const linked = settings.connection_state === "open";
  return (
    <Card
      id="whatsapp"
      title="WhatsApp number"
      icon={<span className={`${s.stepNumber} ${linked ? s.stepNumberDone : ""}`}>2</span>}
      description="Link any WhatsApp account as a linked device, for example your own number while testing. To change numbers later, unlink and link the new one; groups, schedules and history are kept."
    >
      <div className={s.session}>
        {workerReady ? (
          canEdit ? <ReportBotConnection polling initial={{ state: settings.connection_state, number: settings.connected_number, name: settings.connected_name, error: settings.connection_error }} />
            : <div className={s.sessionState}><Badge tone={linked ? "good" : "neutral"}>{linked ? "Connected" : "Not linked"}</Badge>{settings.connected_number ? <strong>+{settings.connected_number}</strong> : null}</div>
        ) : <p className={s.hint}>Save the worker address in step 1 first.</p>}
        {canEdit && workerReady ? (
          <>
            <div className={s.divider} />
            <div className={s.inlineForm}>
              {linked ? null : <form action={connectWhatsApp}><input type="hidden" name="method" value="qr" /><ActionButton className={`${s.button} ${s.primary}`}><Smartphone size={15} aria-hidden />Link with QR code</ActionButton></form>}
              {linked ? null : (
                <form action={connectWhatsApp} className={s.inlineForm}>
                  <input type="hidden" name="method" value="code" />
                  <Field label="Or link with a code" hint="Number with country code, digits only.">
                    <input className={s.input} name="phone" inputMode="numeric" autoComplete="tel" placeholder="919876543210" required pattern="[0-9]{10,15}" />
                  </Field>
                  <ActionButton className={s.button}>Get code</ActionButton>
                </form>
              )}
              {linked || settings.connection_state === "closed" ? (
                <form action={disconnectWhatsApp}>
                  <ActionButton className={`${s.button} ${s.danger}`} confirm="Unlink this WhatsApp number? The bot stops until a number is linked again.">Unlink / switch number</ActionButton>
                </form>
              ) : null}
            </div>
          </>
        ) : null}
        <p className={s.note}><Info size={16} aria-hidden /><span>The bot reads photos only from groups you turn on, and never reads private chats. Your own photos are ignored unless &quot;Check my own photos&quot; is on below.</span></p>
      </div>
    </Card>
  );
}

function SettingsForm({ settings, canEdit }: { settings: ReportBotSettings; canEdit: boolean }) {
  const modes = [
    { value: "off", title: "Off", text: "Not listening to any group." },
    { value: "listen", title: "Listen only", text: "Checks report photos but never posts. Use this while testing." },
    { value: "live", title: "Live", text: "Posts reminders and approved replies in the groups." }
  ];
  return (
    <form action={saveBotSettings} className={s.card}>
      <div className={s.cardHead}>
        <div><h2><span className={s.stepNumber}>3</span>Bot settings</h2><p>Changes apply within a minute.</p></div>
      </div>
      <fieldset disabled={!canEdit} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <div className={s.cardBody} style={{ display: "grid", gap: 22 }}>
          <div className={s.section} id="mode">
            <h3 className={s.sectionTitle}><Bot size={17} aria-hidden />Mode</h3>
            <p className={s.sectionText}>Start in Listen only. Switch to Live when the checks look right.</p>
            <div className={s.choices} role="radiogroup" aria-label="Mode">
              {modes.map((mode) => (
                <label key={mode.value} className={s.choice}>
                  <input type="radio" name="mode" value={mode.value} defaultChecked={settings.mode === mode.value} />
                  <strong>{mode.title}</strong>
                  <span>{mode.text}</span>
                </label>
              ))}
            </div>
          </div>

          <div className={s.section} id="ai">
            <h3 className={s.sectionTitle}><Sparkles size={17} aria-hidden />AI that reads the photos</h3>
            <p className={s.sectionText}>The key is a deployment secret: add {aiKeyName(settings.ai_provider)} in Vercel. It is never stored in the portal.</p>
            <div className={s.formGrid}>
              <Field label="Provider">
                <select className={s.select} name="ai_provider" defaultValue={settings.ai_provider}>
                  <option value="gemini">Google Gemini (free tier)</option>
                  <option value="anthropic">Anthropic Claude (paid)</option>
                  <option value="openai">OpenAI (paid)</option>
                </select>
              </Field>
              <Field label="Model" hint="Pick a suggestion or type a model name.">
                <input className={s.input} name="ai_model" defaultValue={settings.ai_model} required maxLength={100} list="report-bot-models" />
              </Field>
              <datalist id="report-bot-models">
                <option value="gemini-3.8-flash">Gemini · free · best quality</option>
                <option value="gemini-3.5-flash-lite">Gemini · free · faster, higher daily limit</option>
                <option value="claude-opus-5-5">Claude · paid</option>
              </datalist>
              <Field label="Thoroughness" hint="Higher is more careful but slower.">
                <select className={s.select} name="ai_effort" defaultValue={settings.ai_effort}>
                  <option value="low">Quick</option>
                  <option value="medium">Balanced</option>
                  <option value="high">Thorough</option>
                </select>
              </Field>
            </div>
            {settings.ai_provider === "gemini" ? (
              <p className={s.note} style={{ marginTop: 14 }}><Info size={16} aria-hidden /><span>Get a free key at aistudio.google.com. The free tier has daily limits (photos over the limit are retried later), and Google may use free-tier photos to improve its products; choose a paid provider if report photos must stay private.</span></p>
            ) : null}
          </div>

          <div className={s.section}>
            <h3 className={s.sectionTitle}><Send size={17} aria-hidden />Replies and approval</h3>
            <p className={s.sectionText}>Keep &quot;Approve every reply&quot; until you trust the readings.</p>
            <div className={s.formGrid}>
              <Field label="Approval">
                <select className={s.select} name="approval_mode" defaultValue={settings.approval_mode}>
                  <option value="manual">Approve every reply</option>
                  <option value="auto">Send confident results automatically</option>
                </select>
              </Field>
              <Field label="Auto-send when at least" hint="0.85 means the AI is 85% sure. Unclear results always wait for review.">
                <input className={s.input} name="auto_send_min_confidence" type="number" step="0.01" min="0.5" max="1" defaultValue={settings.auto_send_min_confidence} required />
              </Field>
              <Field label="Gap between bot messages" hint="Seconds, per group.">
                <input className={s.input} name="group_min_gap_seconds" type="number" min="0" max="3600" defaultValue={settings.group_min_gap_seconds} required />
              </Field>
              <Field label="Reply delay from" hint="Seconds. A random delay in this range looks more natural.">
                <input className={s.input} name="reply_delay_min_seconds" type="number" min="0" max="3600" defaultValue={settings.reply_delay_min_seconds} required />
              </Field>
              <Field label="Reply delay to" hint="Seconds.">
                <input className={s.input} name="reply_delay_max_seconds" type="number" min="0" max="3600" defaultValue={settings.reply_delay_max_seconds} required />
              </Field>
              <Field label="Skip reminders late by more than" hint="Minutes. Stops a burst of old reminders after an outage.">
                <input className={s.input} name="max_reminder_delay_minutes" type="number" min="1" max="1440" defaultValue={settings.max_reminder_delay_minutes} required />
              </Field>
            </div>
          </div>

          <div className={s.section}>
            <h3 className={s.sectionTitle}><FileText size={17} aria-hidden />Reply format</h3>
            <p className={s.sectionText}>How the reply looks in the group.</p>
            <div className={s.formGrid}>
              <Field label="Layout" className={s.span3} hint={<span className={s.chips}>{["{report}", "{sender}", "{group}", "{date}", "{verdict_label}", "{feedback}"].map((chip) => <code key={chip} className={s.chip}>{chip}</code>)}</span>}>
                <textarea className={s.textarea} name="feedback_template" rows={3} defaultValue={settings.feedback_template} required maxLength={1000} />
              </Field>
              <Field label="When it passes"><input className={s.input} name="label_pass" defaultValue={settings.label_pass} required maxLength={80} /></Field>
              <Field label="When it fails"><input className={s.input} name="label_fail" defaultValue={settings.label_fail} required maxLength={80} /></Field>
              <Field label="When it's unclear"><input className={s.input} name="label_review" defaultValue={settings.label_review} required maxLength={80} /></Field>
              <Field label="Reply language" hint="The AI writes its feedback in this language."><input className={s.input} name="feedback_language" defaultValue={settings.feedback_language} required maxLength={40} /></Field>
              <Field label="Longest reply" hint="Characters."><input className={s.input} name="max_feedback_chars" type="number" min="100" max="3000" defaultValue={settings.max_feedback_chars} required /></Field>
              <Field label="Time zone" hint="Used for schedules and dates, e.g. Asia/Kolkata."><input className={s.input} name="timezone" defaultValue={settings.timezone} required /></Field>
            </div>
          </div>

          <div className={s.section}>
            <h3 className={s.sectionTitle}><Server size={17} aria-hidden />Testing</h3>
            <div style={{ display: "grid", gap: 14, marginTop: 10 }}>
              <Toggle name="include_own_messages" label="Check my own photos" hint="For testing with your own number. The bot's own replies are always ignored." defaultChecked={settings.include_own_messages} />
              <Toggle name="accept_without_request" label="Check photos on days with no report due" hint="Otherwise photos are only checked on days that have a schedule." defaultChecked={settings.accept_without_request} />
            </div>
          </div>
        </div>
        {canEdit ? (
          <div className={`${s.formActions} ${s.stickyActions}`}>
            <ActionButton className={`${s.button} ${s.primary}`}>Save settings</ActionButton>
          </div>
        ) : null}
      </fieldset>
    </form>
  );
}
