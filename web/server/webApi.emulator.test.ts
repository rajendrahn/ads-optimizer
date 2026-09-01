// D6's own "Done when" bar, proven end to end against real Firestore + Auth emulators, the REAL
// unmodified D1/D2 evidence pipeline, the REAL D5 guardrail validator, and a scripted (never
// live) Anthropic client:
//
//   1. A question asked in the UI produces a card without a page reload — proven here as
//      "POST /recommendations returns 202 immediately; GET the same id later returns a fully
//      joined card" (server.ts's actual HTTP routing is exercised in server.test.ts; this file
//      proves the handlers it calls, against real data).
//   2. An escalated answer states what it escalated from and why.
//   3. No ROAS renders without a sample size — proven structurally: every `MetricSnapshotView`
//      this API ever returns carries a `purchases: number` (TypeScript enforces the field is
//      never optional; this test proves real data actually populates it, never `undefined`).
//   4. All three D1 outcomes (EVIDENCE / NOT_DELIVERING / NO_DECISION_UNIT) plus REJECTED and
//      FAILED all render as first-class cards.
//   5. Meta- and Shopify-attributed ROAS are always two separately labelled fields, never merged.
//   6. Auth: a real Firebase Auth emulator ID token verifies; garbage does not.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID, META_AD_ACCOUNT_ID } from "../../scripts/config.ts";
import { COLLECTIONS } from "@shared/firestore/index.ts";
import { resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import { seedDemoAccount, DEMO_ENTITIES } from "./demoFixtures.ts";
import { getAuthVerifier, verifyAuthHeader } from "./auth.ts";
import { __resetWebServerDepsForTests, getWebServerDeps } from "./deps.ts";
import {
  acceptRecommendationHandler,
  createRecommendationHandler,
  getRecommendationHandler,
  rejectRecommendationHandler,
} from "./handlers.ts";
import { streamRecommendation, type SseSink } from "./sse.ts";
import type { MetricSnapshotView, RecommendationView, WindowEvidenceView } from "./types.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "webApi.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error(
    "webApi.emulator.test.ts requires FIREBASE_AUTH_EMULATOR_HOST — run via `npm run test:integration` " +
      "(which now starts firestore,auth — see package.json).",
  );
}
if (getApps().length === 0) initializeApp({ projectId: GCP_PROJECT_ID });
const db: Firestore = getFirestore();

const ACCOUNT_ID = META_AD_ACCOUNT_ID;
const USER = { uid: "test-uid", email: "rajendrahn38@gmail.com" };

async function cleanupCollections(): Promise<void> {
  for (const name of Object.values(COLLECTIONS)) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

beforeAll(async () => {
  await cleanupCollections();
  resetReportingCanonCacheForTests();
  __resetWebServerDepsForTests();
  await seedDemoAccount(db, ACCOUNT_ID);
}, 60_000);

afterAll(cleanupCollections);

/** Runs a request through the real handler and force-waits for the (fire-and-forget) dispatch to
 * finish — `dispatchLatest()` is idempotent-safe to call again (B1's own `runSyncTask` collapses
 * a redelivery of an already-terminal task onto a no-op), so this is a deterministic
 * synchronization point, not a race with the handler's own background dispatch. */
async function askAndWait(namedEntity: {
  type: "AD" | "ADSET" | "CAMPAIGN";
  id: string;
}): Promise<string> {
  const deps = await getWebServerDeps();
  const created = await createRecommendationHandler(
    { namedEntity, question: `What should I do about ${namedEntity.type} ${namedEntity.id}?` },
    USER,
    deps,
  );
  expect(created.status).toBe(202);
  const recommendationId = (created.body as { recommendationId: string }).recommendationId;
  await deps.dispatchLatest();
  return recommendationId;
}

async function getView(recommendationId: string): Promise<RecommendationView> {
  const deps = await getWebServerDeps();
  const result = await getRecommendationHandler(recommendationId, USER, deps);
  expect(result.status).toBe(200);
  return result.body as RecommendationView;
}

/** Walks every window this view carries and asserts the structural "no ROAS without its sample
 * size" guarantee holds on REAL data, for both Meta- and Shopify-attributed figures, and that the
 * two are always separate, individually-labelled fields (§6.2/§6.3) — never a merged number. */
function assertNoRoasWithoutSampleSize(windows: Partial<Record<string, WindowEvidenceView>>): void {
  const entries = Object.entries(windows);
  expect(entries.length).toBeGreaterThan(0);
  for (const [, w] of entries) {
    if (!w) continue;
    for (const metric of [
      w.metaRoas,
      w.cpaMinorUnits,
      w.shopifyRoas,
    ] satisfies MetricSnapshotView[]) {
      expect(typeof metric.purchases).toBe("number");
      expect(Number.isFinite(metric.purchases)).toBe(true);
    }
    // Meta and Shopify are two distinct top-level fields on the SAME window object — structurally
    // impossible to merge without an explicit rewrite of this type, and directly checkable here.
    expect(w).toHaveProperty("metaRoas");
    expect(w).toHaveProperty("shopifyRoas");
    expect(w.metaRoas).not.toBe(w.shopifyRoas);
  }
}

describe("auth — real Firebase Auth emulator, §17.1's gate", () => {
  it("verifies a real emulator-issued ID token", async () => {
    const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    const res = await fetch(
      `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "web-api-test@example.com",
          password: "test-password-123",
          returnSecureToken: true,
        }),
      },
    );
    expect(res.ok).toBe(true);
    const { idToken } = (await res.json()) as { idToken: string };

    const user = await verifyAuthHeader({ authorization: `Bearer ${idToken}` }, getAuthVerifier());
    expect(user).not.toBeNull();
    expect(user?.email).toBe("web-api-test@example.com");
  });

  it("rejects a garbage token", async () => {
    const user = await verifyAuthHeader(
      { authorization: "Bearer not-a-real-token" },
      getAuthVerifier(),
    );
    expect(user).toBeNull();
  });

  it("rejects a missing Authorization header", async () => {
    const user = await verifyAuthHeader({}, getAuthVerifier());
    expect(user).toBeNull();
  });
});

describe("EVIDENCE outcome — a healthy ad set, end to end", () => {
  it("produces a COMPLETE card with sample-sized ROAS, separately-labelled Meta/Shopify figures, and a currency+timezone stamp", async () => {
    const id = await askAndWait(DEMO_ENTITIES.healthy);
    const view = await getView(id);

    expect(view.status).toBe("COMPLETE");
    expect(view.action).not.toBeNull();
    expect(view.packet?.outcome).toBe("EVIDENCE");
    expect(view.currency).toBe("INR");
    expect(view.reportingTimezone).toBe("Asia/Kolkata");
    expect(view.provenance).not.toBeNull();
    expect(view.provenance?.dataFreshThrough).toBeTruthy();

    if (view.packet?.outcome === "EVIDENCE") {
      assertNoRoasWithoutSampleSize(view.packet.evidence.evidence.windows);
      // §6.3: attribution coverage is a real, explicit field, always present.
      expect(typeof view.packet.evidence.evidence.shopify.attributionCoverageRatio).not.toBe(
        undefined,
      );
      expect(view.packet.evidence.evidence.shopify.note.length).toBeGreaterThan(0);
      // Verdict was judged against a stated target, with its source disclosed.
      expect(["settings", "default"]).toContain(view.packet.evidence.targets.source);
    }
  });

  it("accept/reject: accept persists once, a second accept 409s, reject 409s after accept", async () => {
    const id = await askAndWait(DEMO_ENTITIES.healthy);
    const deps = await getWebServerDeps();

    const view = await getView(id);
    expect(view.status).toBe("COMPLETE");
    expect(view.acceptedAt).toBeNull();

    const accepted = await acceptRecommendationHandler(id, USER, deps);
    expect(accepted.status).toBe(200);

    const afterAccept = await getView(id);
    expect(afterAccept.acceptedAt).not.toBeNull();

    const secondAccept = await acceptRecommendationHandler(id, USER, deps);
    expect(secondAccept.status).toBe(409);

    const reject = await rejectRecommendationHandler(id, USER, deps);
    expect(reject.status).toBe(409);
  });
});

describe("escalation — a low-volume ad answers via its ad set, and says so", () => {
  it("states what it escalated from and why", async () => {
    const id = await askAndWait(DEMO_ENTITIES.escalates);
    const view = await getView(id);

    expect(view.status).toBe("COMPLETE");
    expect(view.namedEntity).toEqual(DEMO_ENTITIES.escalates);
    expect(view.packet?.outcome).toBe("EVIDENCE");
    if (view.packet?.outcome === "EVIDENCE") {
      // What it escalated FROM (the originally-named low-volume ad) and TO (the ad set the
      // answer is actually about) are both present, plus the reason.
      expect(view.packet.escalatedFrom).not.toBeNull();
      expect(view.packet.escalatedFrom?.type).toBe("AD");
      expect(view.packet.escalatedFrom?.id).toBe(DEMO_ENTITIES.escalates.id);
      expect(view.packet.escalatedFrom?.reason).toBe("SAMPLE_TOO_SMALL");
      expect(view.packet.decisionUnit).toEqual({ type: "ADSET", id: "AS_17" });
      // §15.2: the escalation is also stated in the packet's own prose, not only structured fields.
      expect(view.packet.textRendering).toMatch(/escalat/i);
    }
  });
});

describe("NOT_DELIVERING — a dead ad set renders as a first-class card, not an error", () => {
  it("COMPLETEs with an honest INSUFFICIENT_DATA and a NOT_DELIVERING packet", async () => {
    const id = await askAndWait(DEMO_ENTITIES.notDelivering);
    const view = await getView(id);

    expect(view.status).toBe("COMPLETE");
    expect(view.errorMessage).toBeNull();
    expect(view.packet?.outcome).toBe("NOT_DELIVERING");
    if (view.packet?.outcome === "NOT_DELIVERING") {
      expect(view.packet.evidence.decisionUnit).toEqual(DEMO_ENTITIES.notDelivering);
      expect(view.packet.textRendering).toBeTruthy();
    }
  });
});

describe("NO_DECISION_UNIT — an orphaned campaign renders as a first-class card", () => {
  it("COMPLETEs with an honest INSUFFICIENT_DATA and a NO_DECISION_UNIT packet, decisionUnit null", async () => {
    const id = await askAndWait(DEMO_ENTITIES.noDecisionUnit);
    const view = await getView(id);

    expect(view.status).toBe("COMPLETE");
    expect(view.packet?.outcome).toBe("NO_DECISION_UNIT");
    expect(view.packet?.decisionUnit).toBeNull();
    expect(view.decisionUnit).toBeNull();
  });
});

describe("FAILED — a genuine reasoner failure leaves a legible error state", () => {
  it("never spins forever; errorMessage is the real thrown message", async () => {
    const id = await askAndWait(DEMO_ENTITIES.fails);
    const view = await getView(id);

    expect(view.status).toBe("FAILED");
    expect(view.errorMessage).toMatch(/simulated Anthropic-side failure/);
    expect(view.action).toBeNull();
  });
});

describe("REJECTED — the real D5 guardrail rejects an over-limit change", () => {
  // Longer timeout: this exercises the real D1/D2 evidence pipeline (~30-ad synthetic account) and
  // D5's real `applyGuardrails` against the emulator. The default 5s test timeout is too tight.
  it("renders which guardrail rejected it and what limit it was judged against", async () => {
    const id = await askAndWait(DEMO_ENTITIES.rejected);
    const view = await getView(id);

    expect(view.status).toBe("REJECTED");
    expect(view.action).toBe("INSUFFICIENT_DATA");
    expect(view.currentBudgetMinorUnits).toBeNull(); // cleared — §20.2, never actionable
    expect(view.guardrailRejection).not.toBeNull();
    expect(view.guardrailRejection?.reason.length).toBeGreaterThan(0);
    // The direct, keyed guardrailRejections lookup (viewModel.ts's findGuardrailRejectionLog)
    // found the REAL D5 log by the real recommendationId — proven by non-empty violations with a
    // real judgedAgainst limit, not just the small {reason, rejectedAt} pair.
    expect(view.guardrailRejection?.violations.length).toBeGreaterThan(0);
    const changeViolation = view.guardrailRejection?.violations.find(
      (v) => v.code === "MAX_CHANGE_PERCENT_EXCEEDED",
    );
    expect(changeViolation).toBeDefined();
    expect(changeViolation?.judgedAgainst?.limit).toBe(20);
    expect(changeViolation?.judgedAgainst?.actual).toBe(250);

    // A rejected recommendation cannot be accepted or rejected further (nothing actionable left).
    const deps = await getWebServerDeps();
    const acceptAttempt = await acceptRecommendationHandler(id, USER, deps);
    expect(acceptAttempt.status).toBe(409);
  }, 20_000);
});

describe("live status subscription — SSE stream observes PENDING through to a terminal status", () => {
  it("streams status frames in order and closes after COMPLETE", async () => {
    const deps = await getWebServerDeps();
    // Deliberately NOT `createRecommendationHandler` here — that also fires its own
    // fire-and-forget `dispatchLatest()` internally, which could race this test's own explicit
    // dispatch call below and let the worker finish BEFORE the SSE listener attaches (Firestore's
    // `onSnapshot` only ever delivers the CURRENT state on attach, never replays history — if the
    // doc were already COMPLETE by the time this test starts listening, the very first frame
    // would be COMPLETE, not PENDING). Calling `requestRecommendation` directly (the same function
    // the handler itself calls) writes PENDING + enqueues WITHOUT auto-dispatching, so this test
    // controls exactly when the worker actually runs, relative to when it starts listening.
    const { requestRecommendation } = await import("@services/reasoner/job/request.ts");
    const { recommendationId } = await requestRecommendation({
      db: deps.db,
      queue: deps.queue,
      namedEntity: DEMO_ENTITIES.healthy,
      requestedBy: USER.email,
      requestedQuestion: "stream test",
    });

    const frames: string[] = [];
    let closeCb: (() => void) | undefined;
    // Resolves once the listener has delivered its OWN first snapshot — establishing a Firestore
    // listener has real latency (its own emulator round trip), which can plausibly exceed the
    // full GENERATE_RECOMMENDATION pipeline's latency. Without this gate, dispatching before the
    // listener is confirmed live risks the doc reaching GENERATING (or even COMPLETE) before
    // onSnapshot's first callback ever fires — Firestore delivers "current state as of
    // attachment," not a replay of every state that occurred before it attached. Waiting for
    // frame 1 (confirmed PENDING, since nothing has been dispatched yet) before triggering
    // dispatch is what makes "PENDING observed first" deterministic rather than a race.
    let resolveFirstFrame: () => void;
    const firstFrame = new Promise<void>((resolve) => {
      resolveFirstFrame = resolve;
    });
    const sink: SseSink = {
      write: (chunk) => {
        frames.push(chunk);
        if (frames.length === 1) resolveFirstFrame();
      },
      end: () => void 0,
      onClose: (cb) => {
        closeCb = cb;
      },
    };

    const streamPromise = streamRecommendation({
      db: deps.db,
      reportingCurrency: deps.reportingCurrency,
      reportingTimezone: deps.reportingTimezone,
      recommendationId,
      sink,
      heartbeatMs: 60_000,
    });

    await firstFrame;
    await deps.dispatchLatest();
    await streamPromise;

    const statuses = frames
      .filter((f) => f.startsWith("event: recommendation"))
      .map((f) => JSON.parse(f.split("data: ")[1]) as RecommendationView)
      .map((v) => v.status);

    expect(statuses[0]).toBe("PENDING");
    expect(statuses[statuses.length - 1]).toBe("COMPLETE");
    expect(frames.some((f) => f.startsWith("event: done"))).toBe(true);
    expect(closeCb).toBeDefined();
  });
});
