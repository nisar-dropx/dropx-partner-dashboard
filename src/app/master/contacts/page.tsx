import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { ContactForm } from "./contact-form";
import { createContact, deleteContact, updateContact } from "./actions";

type Contact = { id: string; contact_no: string | null; email: string | null; bank_account_no: string | null; ifsc: string | null; upi_id: string | null; account_holder_name: string; verified_at: string | null; created_by: string | null };
type Creator = { id: string; full_name: string | null; email: string | null };

export const dynamic = "force-dynamic";

export default async function ContactsPage({ searchParams }: { searchParams?: { edit?: string } }) {
  const authorization = await requirePagePermission("master_contacts", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.master_contacts;
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const result = await supabaseAdmin.from("payment_contacts").select("id, contact_no, email, bank_account_no, ifsc, upi_id, account_holder_name, verified_at, created_by").eq("company_id", companyId).order("account_holder_name");
  if (result.error) throw new Error(`${result.error.message} Run scripts/payment_contacts_upi_verification_v3.sql in Supabase SQL Editor.`);
  const contacts = (result.data ?? []) as Contact[];
  const creatorIds = [...new Set(contacts.map((contact) => contact.created_by).filter((id): id is string => Boolean(id)))];
  const creatorsResult = creatorIds.length
    ? await supabaseAdmin.from("profiles").select("id, full_name, email").in("id", creatorIds)
    : { data: [] as Creator[], error: null };
  if (creatorsResult.error) throw new Error(creatorsResult.error.message);
  const creatorById = new Map(((creatorsResult.data ?? []) as Creator[]).map((creator) => [creator.id, creator]));
  const editContact = permission.canEdit ? contacts.find((contact) => contact.id === searchParams?.edit) ?? null : null;

  return <AppShell active="Contacts" pageCode="master_contacts">
    <PageHead eyebrow="Master Data" title="Contacts" subtitle="Reuse verified bank accounts and UPI IDs without repeating paid verification." />
    {permission.canAdd ? <section className="panel"><div className="panel-head"><div><h2>Add contact</h2><p className="subtle">Store a verified beneficiary account.</p></div></div><ContactForm action={createContact} /></section> : null}
    {permission.canView ? <section className="panel"><div className="panel-head"><div><h2>Contact list</h2><p className="subtle">{contacts.length} records</p></div></div><div className="table-wrap"><table><thead><tr><th>Account holder</th><th>Payment details</th><th>Contact no</th><th>Email</th><th>Created by</th><th>Source</th>{permission.canEdit ? <th>Action</th> : null}</tr></thead><tbody>{contacts.length ? contacts.map((contact) => { const creator = contact.created_by ? creatorById.get(contact.created_by) : null; return <tr key={contact.id}><td><strong>{contact.account_holder_name}</strong></td><td>{contact.upi_id ? <>UPI: {contact.upi_id}</> : <>{contact.bank_account_no}<br /><span className="subtle">{contact.ifsc}</span></>}</td><td>{contact.contact_no || "-"}</td><td>{contact.email || "-"}</td><td><strong>{creator?.full_name || "Unknown"}</strong><br /><span className="subtle">{creator?.email || "-"}</span></td><td>{contact.verified_at ? "Verified" : "Manual"}</td>{permission.canEdit ? <td><PendingLink className="button secondary compact" href={`/master/contacts?edit=${contact.id}`} scroll={false}>Edit</PendingLink></td> : null}</tr>; }) : <tr><td className="empty-cell" colSpan={permission.canEdit ? 7 : 6}>No contacts added yet.</td></tr>}</tbody></table></div></section> : null}
    {editContact ? <div className="modal-backdrop"><section className="modal-panel wide"><div className="panel-head"><div><h2>Edit contact</h2><p className="subtle">Update beneficiary details.</p></div><PendingLink className="icon-button" href="/master/contacts" scroll={false}>x</PendingLink></div><ContactForm action={updateContact} contact={editContact} submitLabel="Save changes" /><form action={deleteContact} className="modal-danger-action"><input name="id" type="hidden" value={editContact.id} /><button className="button danger" type="submit">Delete contact</button></form></section></div> : null}
  </AppShell>;
}
