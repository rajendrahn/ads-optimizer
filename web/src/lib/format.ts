// D6 — small, browser-local formatting helpers. Deliberately NOT imported from
// `@shared/canon/money.ts` — that module is pure (no Firestore), but it lives under `@shared`,
// which web/eslint.config.js's `no-restricted-imports` rule blocks wholesale for web/src (see
// that file's comment: keeping the whole `@shared`/`@services` boundary structurally closed to
// the browser bundle is simpler and safer than reasoning about which individual files under it
// happen to be browser-safe today and might stop being tomorrow).

const MINOR_UNIT_EXPONENT_OVERRIDES: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
};

function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENT_OVERRIDES[currency.toUpperCase()] ?? 2;
}

/** Formats integer minor units (paise) as a currency string — mirrors
 * `shared/canon/money.ts#formatMinorUnitsAsDecimal` in spirit but through `Intl.NumberFormat`
 * for locale-correct grouping/symbol placement, never a bare minor-units integer presented as if
 * it were decimal currency (§0.2). */
export function formatMoney(amountMinorUnits: number, currency: string): string {
  const exponent = minorUnitExponent(currency);
  const amount = amountMinorUnits / 10 ** exponent;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(exponent)}`;
  }
}

export function formatPercent(value: number, fractionDigits = 0): string {
  return `${value.toFixed(fractionDigits)}%`;
}

export function formatRatio(value: number, fractionDigits = 2): string {
  return value.toFixed(fractionDigits);
}

export function formatDateTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function formatRelativeFreshness(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}
