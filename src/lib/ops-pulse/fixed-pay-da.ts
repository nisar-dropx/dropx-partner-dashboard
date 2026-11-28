import "server-only";

import { cpsShipmentCount } from "@/lib/ops-pulse/cps";
import {
  fixedPayCps,
  projectFixedPayDaStations,
  type FixedPayDaStation
} from "@/lib/ops-pulse/fixed-pay-da-math";
import { loadCpsSnapshot } from "@/lib/ops-pulse/cps-snapshot";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";

export type {
  FixedPayDaDay,
  FixedPayDaPersonDay,
  FixedPayDaStation
} from "@/lib/ops-pulse/fixed-pay-da-math";

export {
  fixedPayCps,
  fixedPaySalary,
  fixedPayShipments,
  projectFixedPayDaStations
} from "@/lib/ops-pulse/fixed-pay-da-math";

export type FixedPayDaTotals = {
  associates: number;
  workedDays: number;
  salary: number;
  deliveries: number;
  customerReturns: number;
  shipments: number;
  pendingDays: number;
  cps: number | null;
  activeStations: number;
};

export type FixedPayDaResult = {
  stations: FixedPayDaStation[];
  totals: FixedPayDaTotals;
  error: string | null;
};

export async function loadFixedPayDa(
  companyId: string,
  locations: CodLocationRow[],
  from: string,
  to: string
): Promise<FixedPayDaResult> {
  try {
    if (!locations.length) {
      return {
        stations: [],
        totals: {
          associates: 0,
          workedDays: 0,
          salary: 0,
          deliveries: 0,
          customerReturns: 0,
          shipments: 0,
          pendingDays: 0,
          cps: null,
          activeStations: 0
        },
        error: null
      };
    }
    const snapshot = await loadCpsSnapshot(companyId, from, to, locations);
    const stations = projectFixedPayDaStations(locations, snapshot.da_details ?? []);
    const salary = stations.reduce((sum, station) => sum + station.salary, 0);
    const deliveries = stations.reduce((sum, station) => sum + station.deliveries, 0);
    const customerReturns = stations.reduce((sum, station) => sum + station.customerReturns, 0);
    const shipments = cpsShipmentCount(deliveries, customerReturns);
    const totals: FixedPayDaTotals = {
      associates: stations.reduce((sum, station) => sum + station.associates, 0),
      workedDays: stations.reduce((sum, station) => sum + station.workedDays, 0),
      salary,
      deliveries,
      customerReturns,
      shipments,
      pendingDays: stations.reduce((sum, station) => sum + station.pendingDays, 0),
      cps: fixedPayCps(salary, shipments),
      activeStations: stations.filter((station) => station.salary > 0 || station.shipments > 0).length
    };
    return { stations, totals, error: null };
  } catch (error) {
    return {
      stations: projectFixedPayDaStations(locations, []),
      totals: {
        associates: 0,
        workedDays: 0,
        salary: 0,
        deliveries: 0,
        customerReturns: 0,
        shipments: 0,
        pendingDays: 0,
        cps: null,
        activeStations: 0
      },
      error: error instanceof Error ? error.message : "Fixed Pay DA CPS could not be loaded."
    };
  }
}
