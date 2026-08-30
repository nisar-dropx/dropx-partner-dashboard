export type ContractorRegisterView = "active" | "inactive" | "compatibility";

type ContractorRegisterRow = {
  id: string;
  is_active: boolean;
};

export function contractorRegisterViewFrom(value: string | null | undefined): ContractorRegisterView {
  if (value === "inactive" || value === "compatibility") return value;
  return "active";
}

export function filterContractorRegisterRows<T extends ContractorRegisterRow>(
  rows: T[],
  compatibilitySourceIds: ReadonlySet<string>,
  view: ContractorRegisterView
) {
  if (view === "compatibility") {
    return rows.filter((row) => compatibilitySourceIds.has(row.id));
  }

  return rows.filter((row) => (
    !compatibilitySourceIds.has(row.id) &&
    (view === "active" ? row.is_active : !row.is_active)
  ));
}
