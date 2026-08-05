import { supabaseAdmin } from "@/lib/supabase-admin";

export type UserPaymentContact = {
  id: string;
  account_holder_name: string;
  bank_account_no: string | null;
  contact_no: string | null;
  email: string | null;
  ifsc: string | null;
  upi_id: string | null;
};

export async function loadUserPaymentContacts(companyId: string, userId: string) {
  if (!supabaseAdmin) return [] as UserPaymentContact[];
  const result = await supabaseAdmin
    .from("payment_contacts")
    .select("id, account_holder_name, bank_account_no, contact_no, email, ifsc, upi_id")
    .eq("company_id", companyId)
    .eq("created_by", userId)
    .order("account_holder_name");
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []) as UserPaymentContact[];
}
