import type { PaymentAllocationHistoryEntry } from './payment-allocation-history.ts';

export type ProviderMappingLookupEntry = {
  key: string;
  stationId: string;
  stationLabel: string;
  workforceId: string;
  dropxId: string;
  fullName: string;
  providerMemberId: string;
  providerMemberName: string;
  profileLocationLabel: string;
  restrictedMapping?: boolean;
  history: PaymentAllocationHistoryEntry[];
};

export const mappingLookupToday = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

export function filterProviderMappingLookup(entries: ProviderMappingLookupEntry[], query: string, stationId: string, includeHistory: boolean) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return entries.filter(entry => (!stationId || entry.stationId === stationId)
    && (includeHistory || !entry.history.length || entry.history.some(item => item.storedStatus !== 'cancelled' && (!item.effectiveTo || item.effectiveTo >= mappingLookupToday())))
    && terms.every(term => [entry.dropxId, entry.fullName, entry.providerMemberId, entry.providerMemberName, entry.stationLabel, entry.profileLocationLabel].join(' ').toLowerCase().includes(term)));
}
