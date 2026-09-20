import {WorkforceMileageDesk,type MileageSearch} from '@/components/workforce-mileage-desk';
import {submitMileage} from './actions';
export const dynamic='force-dynamic';
export default function MileagePage({searchParams}:{searchParams?:MileageSearch}){
 return <WorkforceMileageDesk pageCode="ops_workforce_mileage" active="Team Ops" path="/attendance/workforce-mileage" params={searchParams} submit={submitMileage}/>;
}
