import { parseShiftSlot } from "@/lib/ops-pulse/si-handover/model";
import { loadPickerHeadcountFromPunches } from "@/lib/ops-pulse/si-handover/picker-headcount";
import { context, readChecklist } from "@/lib/ops-pulse/si-handover/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const checklistId = String(url.searchParams.get("checklistId") || "").trim();
    if (!checklistId) throw Error("Checklist is required.");
    const c = await context();
    const focused = await readChecklist(checklistId, c);
    const slot = parseShiftSlot(focused.checklist.shift_slot);
    const snapshot = await loadPickerHeadcountFromPunches({
      companyId: c.companyId,
      locationId: focused.checklist.location_id,
      shiftDate: focused.checklist.shift_date,
      shiftSlot: slot,
      shiftSlots: c.master.settings.shiftSlots,
    });
    return Response.json(snapshot);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Unable to load punch headcount." },
      { status: 400 },
    );
  }
}
