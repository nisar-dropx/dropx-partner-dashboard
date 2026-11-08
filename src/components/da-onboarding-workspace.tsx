'use client';
import {useState} from 'react';
import {usePathname,useRouter} from 'next/navigation';
import {DAOnboardingDesk} from './da-onboarding-desk';
import {AmazonDaDesk} from '@/app/ops-pulse/workforce/amazon-onboarding/view';
import styles from './da-onboarding-desk.module.css';
type Props=React.ComponentProps<typeof DAOnboardingDesk>&{initialTab?:string};
export function DAOnboardingWorkspace({initialTab,...props}:Props){
 const router=useRouter(),path=usePathname();
 const amazon=props.canAmazon&&(initialTab==='amazon'||(!initialTab&&props.initialView?.startsWith('bgc')));
 const [station,setStation]=useState(props.initialStation||props.initialStations?.[0]||props.stations.find(s=>s.supported)?.id||'');
 function navigate(tab:string){const q=new URLSearchParams(window.location.search);q.set('tab',tab);if(station)q.set('station',station);q.delete('view');router.push(path+'?'+q);}
 return <div className={styles.workspace}>
  {amazon?<><div className={styles.secondaryNav}><button onClick={()=>navigate('workforce')}>← Workforce onboarding</button><span>Amazon status · provider reference</span></div><header className={styles.heading}><div><small>AMAZON</small><h1>Amazon DA onboarding</h1><p>Amazon activation, milestones and verification.</p></div></header><AmazonDaDesk stations={props.stations.filter(s=>s.supported)} initialStation={station} initialStations={props.initialStations} initialView={props.initialView||'auto'} canEdit={props.canEdit} onStationChange={setStation}/></>:<DAOnboardingDesk {...props} initialStation={station} onAmazon={props.canAmazon?()=>navigate('amazon'):undefined}/>}
 </div>;
}
