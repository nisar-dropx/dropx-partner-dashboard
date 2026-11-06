import { NextResponse } from "next/server";
import { requireCompanyId } from "@/lib/company-scope";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { canFlashStationBoardReportBot } from "@/lib/ops-pulse/station-board-report-bot-access";
import { flashStationBoardToTestingGroup, type BoardFlashImage } from "@/lib/ops-pulse/station-board-report-bot";
import { getAuthorization } from "@/lib/authorization";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function asMime(value: string | null | undefined): BoardFlashImage["mime"] | null {
  const mime = String(value ?? "").trim().toLowerCase();
  if (mime === "image/jpg") return "image/jpeg";
  return ALLOWED_MIME.has(mime) ? (mime as BoardFlashImage["mime"]) : null;
}

export async function POST(request: Request) {
  try {
    const denied = await requireEddApi("edd_station_board");
    if (denied) return denied;

    const authorization = await getAuthorization();
    if (!authorization?.companyId) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }
    if (!canFlashStationBoardReportBot(authorization)) {
      return NextResponse.json({ error: "This flash option is not available for your account." }, { status: 403 });
    }

    const form = await request.formData();
    const title = String(form.get("title") ?? "").trim().slice(0, 200);
    const subtitle = String(form.get("subtitle") ?? "").trim().slice(0, 300);
    const view = String(form.get("view") ?? "").trim().slice(0, 40) || "board";
    const businessDate = String(form.get("businessDate") ?? "").trim();
    const stationCountRaw = Number(form.get("stationCount") ?? "");
    const stationCount = Number.isFinite(stationCountRaw) ? Math.max(0, Math.floor(stationCountRaw)) : undefined;
    const pageRaw = Number(form.get("page") ?? "1");
    const pagesRaw = Number(form.get("pages") ?? "1");
    const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
    const pages = Number.isFinite(pagesRaw) ? Math.max(1, Math.floor(pagesRaw)) : 1;
    const skipCaption = String(form.get("skipCaption") ?? "0") === "1";

    if (!title) return NextResponse.json({ error: "title is required." }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      return NextResponse.json({ error: "businessDate must be YYYY-MM-DD." }, { status: 400 });
    }

    const files = form.getAll("images").filter((entry): entry is File => typeof File !== "undefined" && entry instanceof File);
    if (!files.length) return NextResponse.json({ error: "Attach at least one board image." }, { status: 400 });
    if (files.length > 12) return NextResponse.json({ error: "Too many image pages (max 12)." }, { status: 400 });

    const images: BoardFlashImage[] = [];
    for (const file of files) {
      if (file.size <= 0) continue;
      if (file.size > 8 * 1024 * 1024) {
        return NextResponse.json({ error: `Image "${file.name || "page"}" is too large (max 8 MB).` }, { status: 413 });
      }
      const mime = asMime(file.type)
        ?? (file.name.toLowerCase().endsWith(".png") ? "image/png"
          : file.name.toLowerCase().endsWith(".webp") ? "image/webp"
            : file.name.toLowerCase().endsWith(".jpg") || file.name.toLowerCase().endsWith(".jpeg") ? "image/jpeg"
              : null);
      if (!mime) return NextResponse.json({ error: "Only JPEG, PNG or WebP board images are accepted." }, { status: 400 });
      images.push({ bytes: new Uint8Array(await file.arrayBuffer()), mime });
    }
    if (!images.length) return NextResponse.json({ error: "Attach at least one board image." }, { status: 400 });

    const result = await flashStationBoardToTestingGroup({
      companyId: requireCompanyId(authorization),
      title,
      subtitle,
      view,
      businessDate,
      stationCount,
      images,
      page,
      pages,
      skipAiCaption: skipCaption
    });

    return NextResponse.json({
      ok: true,
      sent: result.sent,
      group: result.groupName,
      caption: result.caption
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to flash via Report Bot.";
    const status = /not available|Sign in|forbidden/i.test(message) ? 403
      : /Live mode|worker|Enable the WhatsApp|Nothing to flash|too large|Too many/i.test(message) ? 422
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
