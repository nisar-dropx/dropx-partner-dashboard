'use client';
import { vehicleTypeOptions, type VehicleTypeMetadata } from '@/lib/fleet/vehicle-type';
import { useFleetVehicleMetadata } from './fleet-vehicle-meta';
import { FleetMultiSelect } from './fleet-multi-select';
export function FleetVehicleTypeFilter({ vehicles, values, onChange, disabled = false }: { vehicles?: VehicleTypeMetadata[]; values: string[]; onChange: (values: string[]) => void; disabled?: boolean }) {
  const registry = useFleetVehicleMetadata();
  return <FleetMultiSelect label="Vehicle type" allLabel="All vehicle types" alwaysSearch disabled={disabled} values={values} onChange={onChange} options={vehicleTypeOptions(vehicles ?? [...registry.values()])} />;
}
