
export function betaWorkspacePageAllowed(account:{activationOnly?:boolean;betaWorkspaceActive?:boolean;onboardingBeta?:boolean},page:string) {
  return Boolean(account.activationOnly&&account.onboardingBeta&&account.betaWorkspaceActive&&['dashboard','profile','attendance','earnings','rate_card'].includes(page));
}
