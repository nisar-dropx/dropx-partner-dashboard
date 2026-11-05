// Match buildSalaryData's production classification from the agreed effective date.
export function amazonProductionCounts(input: {
  workDate: string;
  shipmentType: string;
  delivered: number;
  smd: number;
  smd2: number;
  swa: number;
  finalCReturn: number;
  mfn: number;
  mfnReturn: number;
}) {
  const useSalaryScript = input.workDate >= "2026-10-01";
  const type = input.shipmentType.trim();
  const amazonDelivery = input.delivered + input.smd + input.smd2
    + (useSalaryScript && type === "Delivery" ? input.finalCReturn : 0);
  const cReturn = !useSalaryScript || type === "ReturnPickup" ? input.finalCReturn : 0;
  const totalDelivery = amazonDelivery + input.swa;
  return {
    amazonDelivery,
    cReturn,
    totalDelivery,
    totalActivity: totalDelivery + cReturn + input.mfn + input.mfnReturn
  };
}
