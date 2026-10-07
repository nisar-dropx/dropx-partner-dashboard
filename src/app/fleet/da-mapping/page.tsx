import {AppShell} from '@/components/app-shell';
import {FleetDAMapping} from '@/components/fleet-da-mapping';
import {getAuthorization,hasPermission} from '@/lib/authorization';
export default async function VehicleMappingPage(){
 const auth=await getAuthorization();
 const code=auth&&['fleet_vehicle_view','fleet_station_view','fleet_tracking'].find(p=>hasPermission(auth,p,'access'))||'expense_requests';
 return <AppShell active="Vehicle DA mapping" pageCode={code}><FleetDAMapping/></AppShell>;
}
