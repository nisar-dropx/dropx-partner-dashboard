import { WorkforceOnboardingHub, type OnboardingHubParams } from '@/components/workforce-onboarding-hub';
export const dynamic='force-dynamic';
export default function Page({searchParams}:{searchParams?:OnboardingHubParams}) {
 return <WorkforceOnboardingHub params={searchParams}/>;
}
