"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { vehicleTypeLabel, type VehicleTypeMetadata } from "@/lib/fleet/vehicle-type";

type VehicleMetadata = VehicleTypeMetadata & { vehicleNo: string; model?: string | null; stationCode?: string | null };
const VehicleMetadataContext = createContext<ReadonlyMap<string, VehicleMetadata>>(new Map());

export function FleetVehicleMetadataProvider({ vehicles, children }: { vehicles: VehicleMetadata[]; children: ReactNode }) {
  const index = useMemo(() => new Map(vehicles.map(vehicle => [vehicle.vehicleNo, vehicle])), [vehicles]);
  return <VehicleMetadataContext.Provider value={index}>{children}</VehicleMetadataContext.Provider>;
}

export function useFleetVehicleMetadata() { return useContext(VehicleMetadataContext); }

export function FleetVehicleType({ vehicleNo }: { vehicleNo: string }) {
  const vehicle = useFleetVehicleMetadata().get(vehicleNo);
  return <span className="fc-vehicle-type">{vehicleTypeLabel(vehicle)}</span>;
}

/** Uses the already scoped registry; no extra requests for labels or menus. */
export function FleetVehicleMeta({ vehicleNo, model, stationCode, onlyIfKnown = false }: {
  vehicleNo: string; model?: string | null; stationCode?: string | null; onlyIfKnown?: boolean;
}) {
  const vehicle = useContext(VehicleMetadataContext).get(vehicleNo);
  if (onlyIfKnown && !vehicle) return null;
  const text = `${model?.trim() || vehicle?.model?.trim() || "Model not recorded"} · ${stationCode?.trim() || vehicle?.stationCode?.trim() || "Station not mapped"}`;
  return <span className="fc-vehicle-meta" title={text}>{text}{vehicle ? <span className="fc-vehicle-type">{vehicleTypeLabel(vehicle)}</span> : null}</span>;
}
