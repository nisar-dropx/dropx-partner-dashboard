export const deskUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const deskProfileId = /^amzn1\.flex\.provider\.v1\.[0-9a-f-]{36}$/i;
export function validateDeskAction(body: Record<string, unknown>) {
  if (!deskUuid.test(String(body.id || '')) || !deskProfileId.test(String(body.providerId || '')))
    throw new Error('Refresh the selected associate before continuing.');
  if (!['OFFBOARD','INACTIVATE','RESEND_INVITATION'].includes(String(body.action))) throw new Error('This action is not available.');
  if (body.confirmed !== true) throw new Error('Confirm the selected associate and action.');
  const remarks = String(body.remarks || '').trim();
  if (remarks.length < 3 || remarks.length > 1000) throw new Error('Enter a reason between 3 and 1,000 characters.');
  if (!String(body.expectedStatus || '').trim()) throw new Error('Refresh the Amazon status before continuing.');
  return {id:String(body.id), providerId:String(body.providerId), action:String(body.action), reasonCode:String(body.reasonCode || ''), remarks, expectedStatus:String(body.expectedStatus)};
}
