type RoutableAccount = {
  id: string;
  companyId: string;
  profileType: string;
  reference?: string | null;
  isDefault?: boolean;
};

export const connectAccountKey = (account: RoutableAccount) =>
  `${account.profileType}:${account.companyId}:${account.id}`;

export function resolveConnectRouteAccount<T extends RoutableAccount>(
  accounts: T[],
  selectedKey: string,
  selectedId: string
): T | null {
  // Only resolve accounts returned by the authenticated session. An invalid
  // explicit selector must never silently open a different account.
  if (selectedKey) {
    return accounts.find((account) => connectAccountKey(account) === selectedKey) ?? null;
  }
  if (selectedId.trim()) {
    const reference = selectedId.trim().toLowerCase();
    const matches = accounts.filter((account) =>
      String(account.reference || account.id).trim().toLowerCase() === reference
    );
    // Older readable-ID links may identify several roles or companies. Let the
    // user choose instead of selecting whichever account happens to come first.
    return matches.length === 1 ? matches[0] : null;
  }
  return accounts.find((account) => account.isDefault) ??
    (accounts.length === 1 ? accounts[0] : null);
}

export function connectAccountRoute(route: string, account?: RoutableAccount | null) {
  if (!account) return route;
  const query = new URLSearchParams({
    id: account.reference || account.id,
    account: connectAccountKey(account)
  });
  return `${route}?${query}`;
}
