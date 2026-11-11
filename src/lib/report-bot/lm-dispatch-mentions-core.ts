export type PresencePunch = {
  workerType: "employee" | "contractor";
  workerId: string;
  locationId: string | null;
  punchLabel: string;
  punchTime: string;
  source: string | null;
  id?: string;
};

export function normalizeWhatsAppNumber(value: string | null | undefined) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) digits = `91${digits}`;
  else if (digits.length === 11 && digits.startsWith("0")) digits = `91${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

function workerKey(workerType: string, workerId: string) {
  return `${workerType}:${workerId}`;
}

function eventOrder(row: PresencePunch) {
  const stamp = Date.parse(row.punchTime);
  return Number.isFinite(stamp) ? stamp : 0;
}

/**
 * Returns workers whose latest event is a biometric In at their current People
 * station. A later Out, a manual-only In, or a punch at an old station excludes
 * the worker.
 */
export function presentWorkerKeys(punches: PresencePunch[], expectedLocationByWorker: Map<string, string>) {
  const latest = new Map<string, PresencePunch>();
  for (const row of punches) {
    const key = workerKey(row.workerType, row.workerId);
    const current = latest.get(key);
    const newer = !current || eventOrder(row) > eventOrder(current) ||
      (eventOrder(row) === eventOrder(current) && String(row.id ?? "") > String(current.id ?? ""));
    if (newer) latest.set(key, row);
  }
  const present = new Set<string>();
  for (const [key, row] of latest) {
    if (String(row.source ?? "").trim().toLowerCase() !== "biometric") continue;
    if (!/^in\d*$/i.test(String(row.punchLabel ?? "").trim())) continue;
    if (!row.locationId || row.locationId !== expectedLocationByWorker.get(key)) continue;
    present.add(key);
  }
  return present;
}

/** Includes current biometric Ins plus the latest completed station shift.
 * This is used for evening operational follow-ups where the closing SSA must
 * remain accountable even after punching Out. */
export function lastShiftWorkerKeys(punches: PresencePunch[], expectedLocationByWorker: Map<string,string>) {
  const latest=new Map<string,PresencePunch>();
  for(const row of punches) {
    const key=workerKey(row.workerType,row.workerId);
    if(String(row.source??"").trim().toLowerCase()!=="biometric") continue;
    if(!row.locationId||row.locationId!==expectedLocationByWorker.get(key)) continue;
    const current=latest.get(key);
    if(!current||eventOrder(row)>eventOrder(current)||(eventOrder(row)===eventOrder(current)&&String(row.id??"")>String(current.id??""))) latest.set(key,row);
  }
  const current=presentWorkerKeys(punches,expectedLocationByWorker);
  const latestByLocation=new Map<string,number>();
  for(const row of latest.values()) latestByLocation.set(row.locationId!,Math.max(latestByLocation.get(row.locationId!)||0,eventOrder(row)));
  const selected=new Set(current);
  const lastShiftWindowMs=3*60*60*1000;
  for(const [key,row] of latest) if(eventOrder(row)>=(latestByLocation.get(row.locationId!)||0)-lastShiftWindowMs) selected.add(key);
  return selected;
}

export function attendanceWorkerKey(workerType: "employee" | "contractor", workerId: string) {
  return workerKey(workerType, workerId);
}

/** Recognition follows People station assignments, independent of current attendance. */
export function teamLeaderMentionNumbers(
  directory: { role: string; roleCode: string; locationId: string | null; phone: string | null }[],
  locationIds: string[],
) {
  const locations = new Set(locationIds);
  const normalizeRole = (value: string) => value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const teamLeadRoles = new Set(["TL", "TEAMLEAD", "TEAMLEADER"]);
  return [...new Set(directory.flatMap(person => {
    if (!person.locationId || !locations.has(person.locationId)) return [];
    if (!teamLeadRoles.has(normalizeRole(person.roleCode)) && !teamLeadRoles.has(normalizeRole(person.role))) return [];
    const number = normalizeWhatsAppNumber(person.phone);
    return number ? [number] : [];
  }))];
}
