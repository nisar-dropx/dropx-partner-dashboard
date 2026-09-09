import { redirect } from "next/navigation";
export default function StationEddRedirect({ params }: { params: { stationCode: string } }) {
  redirect(`/edd/${encodeURIComponent(params.stationCode)}/edds`);
}
