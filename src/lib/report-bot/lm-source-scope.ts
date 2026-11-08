type Relation = { code:string|null } | Array<{ code:string|null }> | null;

export type DispatchSourceRow = {
  is_ho:boolean|null;
  hide_from_location_list:boolean|null;
  location_models:Relation;
};

function modelCode(row:DispatchSourceRow) {
  const model = Array.isArray(row.location_models) ? row.location_models[0] : row.location_models;
  return String(model?.code || "").trim().toUpperCase();
}

export function filterDispatchSourceRows<T extends DispatchSourceRow>(rows:T[], configuredModels:string[] = []) {
  const models = new Set(configuredModels.map(value=>value.trim().toUpperCase()).filter(Boolean));
  return rows.filter(row=>{
    const model = modelCode(row);
    return !row.is_ho && !row.hide_from_location_list && model !== "NOW" && (!models.size || models.has(model));
  });
}
