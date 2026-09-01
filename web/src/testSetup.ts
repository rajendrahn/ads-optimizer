// D6 — component test setup: extends vitest's `expect` with @testing-library/jest-dom's
// DOM matchers (toBeInTheDocument, toHaveTextContent, ...), and unmounts/cleans the DOM after
// every test. @testing-library/react's own auto-cleanup relies on a GLOBAL `afterEach` existing;
// vitest.web.config.ts deliberately sets `globals: false` (matching this repo's own convention —
// every other test file explicitly imports `describe`/`it`/`expect` from "vitest" rather than
// relying on injected globals), so that auto-registration never fires and must be done here
// explicitly — confirmed by a real cross-test DOM leak (a later test's `queryByText` matching an
// earlier test's un-unmounted render) before this was added.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(cleanup);
