/**
 * Server-side request timing (terminal / hosting logs). Filter by "ApiTiming".
 */
export function createApiTimer(routeLabel: string) {
  const t0 = Date.now();
  return {
    step(name: string, extra?: Record<string, unknown>) {
      const ms = Date.now() - t0;
      console.log(`[ApiTiming] ${routeLabel}`, { step: name, msSinceStart: ms, ...extra });
    },
    elapsed() {
      return Date.now() - t0;
    },
  };
}
