// Translates the canon's pinned `attributionWindow` string (§5.3, e.g. "7d_click_1d_view" —
// confirmed live in B2 as this account's real per-ad-set `attribution_spec`) into the token
// array Meta's `action_attribution_windows` request parameter expects (e.g.
// `["7d_click","1d_view"]`).
//
// Meta's own valid tokens are always `{1|7|28}d_{click|view}` (plus a legacy "default"), so the
// combined settings string is just those tokens concatenated with "_". Extracting them with a
// regex rather than a fixed split keeps this correct for a single-window value ("7d_click"
// alone) as well as the two-window default, without hand-coding every combination.
//
// Fails loudly on a string that yields no tokens — §5.3: "Pin one window... on every insight
// document. They are part of the measurement, not configuration." Silently sending an empty
// array would make Meta fall back to its own platform default window, which is exactly the kind
// of unpinned, unrecorded attribution setting §5.3 exists to rule out.

const ATTRIBUTION_TOKEN_PATTERN = /\d+d_(?:click|view)/g;

export function parseAttributionWindowTokens(attributionWindow: string): string[] {
  const tokens = attributionWindow.match(ATTRIBUTION_TOKEN_PATTERN);
  if (!tokens || tokens.length === 0) {
    throw new Error(
      `parseAttributionWindowTokens: "${attributionWindow}" does not contain any recognizable ` +
        `Meta attribution window token (expected one or more of "{1|7|28}d_click"/"{1|7|28}d_view")`,
    );
  }
  return tokens;
}
