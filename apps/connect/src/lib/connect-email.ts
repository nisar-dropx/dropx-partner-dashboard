import nodemailer from "nodemailer";
import { supabaseAdmin } from "./supabase-admin";

export async function sendConnectEmail(input: { companyId: string; to: string[]; cc?: string[]; subject: string; body: string }) {
  if (!supabaseAdmin) throw new Error("Database is unavailable.");
  const { data, error } = await supabaseAdmin.from("email_notification_settings").select("*").eq("company_id", input.companyId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.is_enabled || !data.smtp_host) throw new Error("Company email delivery is not enabled.");
  const fromAddress = String(data.smtp_from || data.smtp_user || "").trim();
  if (!fromAddress) throw new Error("Company email from address is missing.");
  const name = String(data.from_name || "").replace(/"/g, "").trim();
  const to = Array.from(new Set(input.to.map((item) => item.trim().toLowerCase()).filter(Boolean)));
  const cc = Array.from(new Set((input.cc ?? []).map((item) => item.trim().toLowerCase()).filter((item) => item && !to.includes(item))));
  if (!to.length) throw new Error("No notification recipients were resolved.");
  const transporter = nodemailer.createTransport({ host: data.smtp_host, port: Number(data.smtp_port ?? 587), secure: Number(data.smtp_port) === 465 || Boolean(data.smtp_secure), auth: data.smtp_user && data.smtp_pass ? { user: data.smtp_user, pass: data.smtp_pass } : undefined });
  await transporter.sendMail({ from: name ? `"${name}" <${fromAddress}>` : fromAddress, to, cc: cc.length ? cc : undefined, subject: input.subject, text: input.body });
}
