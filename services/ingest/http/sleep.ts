/** The one real implementation; every caller that needs deterministic tests injects its own. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
