export type ConnectAccountIdentity = {
  id: string;
  companyId: string;
  profileType: string;
};

function accountIdentityKey(account: ConnectAccountIdentity) {
  return `${account.companyId}:${account.profileType}:${account.id}`;
}

export function sameConnectAccountIdentitySet(
  before: ConnectAccountIdentity[],
  after: ConnectAccountIdentity[]
) {
  if (before.length !== after.length) return false;
  const beforeKeys = before.map(accountIdentityKey).sort();
  const afterKeys = after.map(accountIdentityKey).sort();
  return beforeKeys.every((key, index) => key === afterKeys[index]);
}
