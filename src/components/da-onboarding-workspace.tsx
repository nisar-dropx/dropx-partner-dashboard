'use client';
import {useState} from 'react';
import {usePathname,useRouter} from 'next/navigation';
import {DAOnboardingDesk} from './da-onboarding-desk';
import {AmazonDaDesk} from '@/app/ops-pulse/workforce/amazon-onboarding/view';
import styles from './da-onboarding-desk.module.css';
type Props=React.ComponentProps<typeof DAOnboardingDesk>&{initialTab?:string};
/** Keep provider progress and DropX registration as separate, permission-scoped workspaces. */
export function DAOnboardingWorkspace({initialTab,...props}:Props){
 const router=useRouter(),path=usePathname();
 const registrationLink=['joiners','registration'].includes(initialTab||'');
 const tab=props.canAmazon&&!registrationLink?'amazon':'registration';
 const [station,setStation]=useState(props.initialStation||props.initialStations?.[0]||props.stations.find(s=>s.supported)?.id||'');
 function navigate(next:string){const q=new URLSearchParams(window.location.search);q.set('tab',next);if(station)q.set('station',station);q.delete('view');router.push(path+'?'+q);}
 return <div className={styles.workspace}>
  <nav className={styles.workspaceTabs} aria-label="DA onboarding workspace">
   {props.canAmazon?<button aria-current={tab==='amazon'?'page':undefined} onClick={()=>navigate('amazon')}><strong>Amazon onboarding</strong><span>Amazon IDs, dependencies & verification</span></button>:null}
   <button aria-current={tab==='registration'?'page':undefined} onClick={()=>navigate('registration')}><strong>DropX registration & ownership</strong><span>Registration, system email & ID links</span></button>
  </nav>
  {tab==='amazon'?<><header className={styles.heading}><div><small>AMAZON</small><h1>Amazon DA onboarding</h1><p>Invitations, verification and ID status.</p></div></header><AmazonDaDesk stations={props.stations.filter(s=>s.supported)} initialStation={station} initialStations={props.initialStations} initialView={props.initialView||'auto'} canEdit={props.canEdit} onStationChange={setStation}/></>:<DAOnboardingDesk {...props} initialStation={station}/>}
 </div>;
}
