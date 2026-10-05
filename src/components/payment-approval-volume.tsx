import { PaymentVolumeContext } from '@/components/payment-volume-context';
import { loadPaymentVolume, paymentVolumeToday } from '@/lib/payment-volume-data';
import { optionalPaymentEvidence } from '@/lib/optional-payment-evidence';

// Parent page has already authorized this request and station.
export async function PaymentApprovalVolume({ company, station, date }: { company: string; station: string; date: string }) {
  const evidence = await optionalPaymentEvidence(() => loadPaymentVolume(company, station, date, paymentVolumeToday()));
  return <PaymentVolumeContext date={date} initialData={evidence.data} initialError={evidence.error} />;
}
