import { NextRequest } from "next/server";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { locationMailAttachment } from "@/lib/ops-pulse/location-mail";

function cleanFilename(value: unknown) {
  return String(value ?? "attachment").replace(/[\r\n"\\/]+/g, "-").trim() || "attachment";
}

export async function GET(
  request: NextRequest,
  { params }: { params: { messageId: string; attachmentId: string } }
) {
  try {
    const authorization = await requirePagePermission("ops_location_mail", "view");
    const companyId = requireCompanyId(authorization);
    const mailboxId = request.nextUrl.searchParams.get("mailbox") ?? "";
    if (!mailboxId) return new Response("Mailbox is required.", { status: 400 });
    const { client, message } = await locationMailAttachment({ companyId, mailboxId, messageId: params.messageId });
    if (!authorization.hasAllLocationAccess && !authorization.isMasterOwner && !authorization.locationScopeIds.includes(message.station_id)) {
      return new Response("You do not have access to this station attachment.", { status: 403 });
    }
    const attachmentRows = Array.isArray((message.metadata as Record<string, unknown> | null)?.attachments)
      ? (message.metadata as { attachments: Array<{ attachmentId?: string; filename?: string; mimeType?: string }> }).attachments
      : [];
    const attachment = attachmentRows.find((entry) => entry.attachmentId === params.attachmentId);
    if (!attachment) return new Response("Attachment was not found.", { status: 404 });
    const result = await client.getAttachment(message.google_message_id, params.attachmentId);
    const body = Buffer.from(result.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return new Response(body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${cleanFilename(attachment.filename)}"`,
        "Content-Type": attachment.mimeType || "application/octet-stream"
      }
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Attachment could not be downloaded.", { status: 500 });
  }
}
