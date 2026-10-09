/** Greeting follows the viewer's local clock; overnight is not morning. */
export function dashboardGreeting(hour: number) {
  if (!Number.isFinite(hour) || hour < 5 || hour >= 24) return "Hello";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}
