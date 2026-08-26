export function canUseAvailableManagerChain(level: number, resolvedStepCount: number) {
  return level > 1 && resolvedStepCount > 0;
}
