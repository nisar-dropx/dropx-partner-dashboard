export type PaymentFieldOrderMap =
  | ReadonlyMap<string, number>
  | Readonly<Record<string, number | null | undefined>>;

function normalizePaymentFieldId(id: string) {
  return id.trim();
}

export function normalizePaymentFieldCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

export function paymentComponentOrderMap(
  components: ReadonlyArray<{ component_code?: unknown; sort_order?: unknown }>
) {
  const order = new Map<string, number>();
  components.forEach((component, index) => {
    const code = normalizePaymentFieldCode(component.component_code);
    if (!code || order.has(code)) return;
    const configuredRank = Number(component.sort_order);
    order.set(code, Number.isFinite(configuredRank) ? configuredRank : index);
  });
  return order;
}

export function normalizePaymentFieldOrder(
  ids: readonly string[],
  validIds?: Iterable<string>
) {
  const allowedIds = validIds === undefined
    ? null
    : new Set(Array.from(validIds, normalizePaymentFieldId).filter(Boolean));
  const seenIds = new Set<string>();
  const normalizedIds: string[] = [];

  for (const value of ids) {
    const id = normalizePaymentFieldId(value);
    if (!id || seenIds.has(id) || (allowedIds && !allowedIds.has(id))) continue;
    seenIds.add(id);
    normalizedIds.push(id);
  }

  return normalizedIds;
}

export function togglePaymentFieldSelection(currentIds: readonly string[], id: string) {
  const normalizedIds = normalizePaymentFieldOrder(currentIds);
  const normalizedId = normalizePaymentFieldId(id);
  if (!normalizedId) return normalizedIds;
  if (!normalizedIds.includes(normalizedId)) return [...normalizedIds, normalizedId];
  return normalizedIds.filter((currentId) => currentId !== normalizedId);
}

export function movePaymentField(
  currentIds: readonly string[],
  activeId: string,
  targetId: string,
  placement: "before" | "after" = "before"
) {
  const normalizedIds = normalizePaymentFieldOrder(currentIds);
  const normalizedActiveId = normalizePaymentFieldId(activeId);
  const normalizedTargetId = normalizePaymentFieldId(targetId);
  if (
    !normalizedActiveId
    || !normalizedTargetId
    || normalizedActiveId === normalizedTargetId
    || !normalizedIds.includes(normalizedActiveId)
    || !normalizedIds.includes(normalizedTargetId)
  ) {
    return normalizedIds;
  }

  const withoutActive = normalizedIds.filter((id) => id !== normalizedActiveId);
  const targetIndex = withoutActive.indexOf(normalizedTargetId);
  const insertionIndex = targetIndex + (placement === "after" ? 1 : 0);
  return [
    ...withoutActive.slice(0, insertionIndex),
    normalizedActiveId,
    ...withoutActive.slice(insertionIndex)
  ];
}

export function movePaymentFieldByOffset(
  currentIds: readonly string[],
  id: string,
  offset: number
) {
  const normalizedIds = normalizePaymentFieldOrder(currentIds);
  const normalizedId = normalizePaymentFieldId(id);
  const currentIndex = normalizedIds.indexOf(normalizedId);
  if (currentIndex === -1 || !Number.isFinite(offset)) return normalizedIds;

  const targetIndex = Math.max(
    0,
    Math.min(normalizedIds.length - 1, currentIndex + Math.trunc(offset))
  );
  if (targetIndex === currentIndex) return normalizedIds;

  const withoutMoved = normalizedIds.filter((currentId) => currentId !== normalizedId);
  return [
    ...withoutMoved.slice(0, targetIndex),
    normalizedId,
    ...withoutMoved.slice(targetIndex)
  ];
}

function configuredRank(orderMap: PaymentFieldOrderMap, code: string | null | undefined) {
  if (!code) return undefined;
  const mapGetter = (orderMap as ReadonlyMap<string, number>).get;
  const rank = typeof mapGetter === "function"
    ? mapGetter.call(orderMap, code)
    : Object.prototype.hasOwnProperty.call(orderMap, code)
      ? (orderMap as Readonly<Record<string, number | null | undefined>>)[code]
      : undefined;
  return typeof rank === "number" && Number.isFinite(rank) ? rank : undefined;
}

export function sortByPaymentFieldOrder<T>(
  items: readonly T[],
  orderMap: PaymentFieldOrderMap,
  getCode: (item: T) => string | null | undefined
) {
  return items
    .map((item, index) => ({ item, index, rank: configuredRank(orderMap, getCode(item)) }))
    .sort((left, right) => {
      if (left.rank === undefined && right.rank === undefined) return left.index - right.index;
      if (left.rank === undefined) return 1;
      if (right.rank === undefined) return -1;
      return left.rank - right.rank || left.index - right.index;
    })
    .map(({ item }) => item);
}
