// Exact Secret Manager entry names fixed during A0 — SETUP.md §5 ("A4 and every later step
// resolve secrets by these exact names — fix them here and do not change them later").
//
// Every caller resolves a secret by importing SECRET_NAMES from here, never by writing the
// string literal inline and never by deriving a name from some other convention.

export const SECRET_NAMES = {
  metaSystemUserToken: "meta-system-user-token",
  metaAppSecret: "meta-app-secret",
  shopifyAdminToken: "shopify-admin-token",
  shopifyWebhookSecret: "shopify-webhook-secret",
  anthropicApiKey: "anthropic-api-key",
} as const;

export type SecretName = (typeof SECRET_NAMES)[keyof typeof SECRET_NAMES];
