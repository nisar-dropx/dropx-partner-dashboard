import { AsyncLocalStorage } from 'node:async_hooks';
import {setFleetAuditContextReader,type FleetAuditContext} from './audit-fetch';
export const fleetAuditContext=new AsyncLocalStorage<FleetAuditContext>();
setFleetAuditContextReader(()=>fleetAuditContext.getStore());
