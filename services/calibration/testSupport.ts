// Test-only helper, not itself a test file (mirrors testFixtures.ts's convention elsewhere in
// this codebase — e.g. services/backtest/testFixtures.ts). This repo's eslint config forbids
// non-null assertions (`x!`); `must` is the narrowing alternative every test in this directory
// uses instead of one, so a `.find()`/array-index result that "should" exist is checked, not
// assumed.

export function must<T>(
  value: T | null | undefined,
  message = "expected a value, got null/undefined",
): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}
