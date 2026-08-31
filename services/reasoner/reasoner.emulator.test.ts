// D3's tool-loop control flow, proven with a SCRIPTED fake Anthropic client against a REAL
// (emulator) Firestore — `generateRecommendation` always calls `loadActiveAdOptimizationKnowledge`
// before the loop starts, so this cannot be a Firestore-free unit test. No live API call is made
// here. Live behaviour (a real recommendation, real cache_read_input_tokens, the real injection
// test) is proven separately by `scripts/verify-d3-reasoner.ts`, run manually per this step's own
// "be frugal with live calls" constraint. This file proves the *mechanics*: stop_reason branching,
// tool-result threading, provenance, and structured-output validation.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { GCP_PROJECT_ID } from "../../scripts/config.ts";
import { COLLECTIONS } from "@shared/firestore/index.ts";
import { TEST_CANON } from "../ingest/meta/entities/testFixtures.ts";
import { buildDecisionPacket } from "../evidence/packetBuilder.ts";
import type { ScalingEvidenceResult } from "../evidence/types.ts";
import { generateRecommendation, ReasonerRefusalError } from "./reasoner.ts";
import { refreshAdOptimizationKnowledge, SEED_KNOWLEDGE_V1 } from "./knowledge.ts";
import type { ReasonerContext } from "./types.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "reasoner.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

async function cleanup() {
  const snaps = await db.collection(COLLECTIONS.adOptimizationKnowledge).listDocuments();
  await Promise.all(snaps.map((ref) => ref.delete()));
}
beforeEach(cleanup);
afterAll(cleanup);

const NOT_DELIVERING_RESULT: ScalingEvidenceResult = {
  outcome: "NOT_DELIVERING",
  namedEntity: { type: "ADSET", id: "as_dead" },
  decisionUnit: { type: "ADSET", id: "as_dead" },
  decisionUnitName: "Legacy remarketing ad set",
  primaryWindow: "28d",
  detail: "Zero spend and zero impressions in the primary window.",
};

const PACKET = buildDecisionPacket({
  namedEntity: { type: "ADSET", id: "as_dead" },
  result: NOT_DELIVERING_RESULT,
  currentAccountDataVersion: 7,
  now: new Date("2026-08-30T12:00:00Z"),
});

const VALID_RECOMMENDATION = {
  recommendation: "INSUFFICIENT_DATA",
  decisionUnit: { type: "ADSET", id: "as_dead" },
  currentBudgetMinorUnits: null,
  recommendedBudgetMinorUnits: null,
  changePercent: null,
  confidence: 0.1,
  summary: "This ad set is not delivering — no budget change can be evaluated from zero spend.",
  primaryReasons: ["Zero spend and zero impressions in the primary 28d window."],
  risks: [],
  doNotDo: ["Do not scale a non-delivering ad set."],
  recheckConditions: null,
};

function textBlock(json: unknown): Anthropic.Beta.BetaTextBlock {
  return { type: "text", text: JSON.stringify(json), citations: null };
}

function usage(overrides: Partial<Anthropic.Beta.BetaUsage> = {}): Anthropic.Beta.BetaUsage {
  return {
    input_tokens: 1200,
    output_tokens: 300,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1000,
    cache_creation: null,
    fallback_credit: null,
    inference_geo: null,
    server_tool_use: null,
    speed: null,
    ...overrides,
  } as Anthropic.Beta.BetaUsage;
}

function ctxFor(db: Firestore): ReasonerContext {
  return { db, canon: TEST_CANON };
}

describe("generateRecommendation — tool loop mechanics (mocked client, real Firestore)", () => {
  it("runs a tool_use turn, threads the result back, and validates the final structured output", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "msg_1",
        model: "claude-fable-5",
        stop_reason: "tool_use",
        stop_details: null,
        content: [
          { type: "tool_use", id: "tu_1", name: "get_similar_ads", input: { adId: "238591234" } },
        ],
        usage: usage({ cache_read_input_tokens: 0 }), // first call — nothing cached yet
      })
      .mockResolvedValueOnce({
        id: "msg_2",
        model: "claude-fable-5",
        stop_reason: "end_turn",
        stop_details: null,
        content: [textBlock(VALID_RECOMMENDATION)],
        usage: usage({ cache_read_input_tokens: 1500 }), // second call — prefix now served from cache
      });
    const fakeClient = { beta: { messages: { create } } } as unknown as Anthropic;

    const result = await generateRecommendation({
      ctx: ctxFor(db),
      packet: PACKET,
      client: fakeClient,
      now: new Date("2026-08-30T12:05:00Z"),
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.recommendation.recommendation).toBe("INSUFFICIENT_DATA");
    expect(result.toolCallLog).toEqual([
      { toolName: "get_similar_ads", input: { adId: "238591234" }, isError: false },
    ]);

    // Provenance — §19.4.
    expect(result.provenance.model).toBe("claude-fable-5");
    expect(result.provenance.provider).toBe("anthropic");
    expect(result.provenance.decisionEngineVersion).toBe("d1-scaling-evidence-v1");
    expect(result.provenance.featureVersion).toBe(7);
    expect(result.provenance.dataVersion).toBe(7);
    expect(result.provenance.dataFreshThrough).toBe("2026-08-30T12:00:00.000Z");
    expect(result.provenance.generatedAt).toBe("2026-08-30T12:05:00.000Z");
    expect(result.provenance.adOptimizationKnowledgeVersion).toBeNull(); // none seeded
    expect(result.provenance.stopReason).toBe("end_turn");
    expect(result.provenance.usage.cacheReadInputTokens).toBe(1500);

    // §19.3 caching order: `tools`/`system` are identical byte-for-byte across both calls —
    // nothing volatile leaked into the cached prefix mid-loop.
    const [firstCallArgs] = create.mock.calls[0] as [Record<string, unknown>];
    const [secondCallArgs] = create.mock.calls[1] as [Record<string, unknown>];
    expect(secondCallArgs.tools).toEqual(firstCallArgs.tools);
    expect(secondCallArgs.system).toEqual(firstCallArgs.system);

    // §19.3: thinking omitted entirely (never set), no sampling parameters, server-side fallbacks
    // configured on every call.
    expect(firstCallArgs.thinking).toBeUndefined();
    expect(firstCallArgs.temperature).toBeUndefined();
    expect(firstCallArgs.fallbacks).toBe("default");
    expect(firstCallArgs.betas).toEqual(["server-side-fallback-2026-07-01"]);
  });

  it("stamps provenance with the published knowledge version once one is active", async () => {
    await refreshAdOptimizationKnowledge({
      db,
      version: "v1",
      publishedBy: "seed",
      entries: SEED_KNOWLEDGE_V1,
    });
    const create = vi.fn().mockResolvedValue({
      id: "msg_1",
      model: "claude-fable-5",
      stop_reason: "end_turn",
      stop_details: null,
      content: [textBlock(VALID_RECOMMENDATION)],
      usage: usage(),
    });
    const fakeClient = { beta: { messages: { create } } } as unknown as Anthropic;

    const result = await generateRecommendation({
      ctx: ctxFor(db),
      packet: PACKET,
      client: fakeClient,
    });
    expect(result.provenance.adOptimizationKnowledgeVersion).toBe("v1");

    // And the rendered knowledge block actually reached the request's cached system prefix.
    const [callArgs] = create.mock.calls[0] as [{ system: { text: string }[] }];
    expect(callArgs.system[1].text).toContain("ad-optimization-knowledge-playbook-v1");
  });

  it("throws ReasonerRefusalError and never reads content when stop_reason is refusal", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "msg_1",
      model: "claude-fable-5",
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: null },
      content: [{ type: "text", text: "should never be read", citations: null }],
      usage: usage(),
    });
    const fakeClient = { beta: { messages: { create } } } as unknown as Anthropic;

    try {
      await generateRecommendation({ ctx: ctxFor(db), packet: PACKET, client: fakeClient });
      expect.unreachable("expected a ReasonerRefusalError");
    } catch (error) {
      expect(error).toBeInstanceOf(ReasonerRefusalError);
      expect((error as ReasonerRefusalError).category).toBe("cyber");
    }
  });

  it("throws on max_tokens rather than returning a truncated recommendation", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "msg_1",
      model: "claude-fable-5",
      stop_reason: "max_tokens",
      stop_details: null,
      content: [textBlock({ recommendation: "HOLD" })], // deliberately incomplete
      usage: usage(),
    });
    const fakeClient = { beta: { messages: { create } } } as unknown as Anthropic;

    await expect(
      generateRecommendation({ ctx: ctxFor(db), packet: PACKET, client: fakeClient }),
    ).rejects.toThrow(/max_tokens/);
  });

  it("rejects a final response whose text does not validate against the recommendation schema", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "msg_1",
      model: "claude-fable-5",
      stop_reason: "end_turn",
      stop_details: null,
      content: [textBlock({ recommendation: "NOT_A_REAL_TYPE" })],
      usage: usage(),
    });
    const fakeClient = { beta: { messages: { create } } } as unknown as Anthropic;

    await expect(
      generateRecommendation({ ctx: ctxFor(db), packet: PACKET, client: fakeClient }),
    ).rejects.toThrow();
  });

  it("throws rather than reasoning over a packet with no text rendering", async () => {
    const brokenPacket = { ...PACKET, textRendering: null };
    const create = vi.fn();
    const fakeClient = { beta: { messages: { create } } } as unknown as Anthropic;
    await expect(
      generateRecommendation({ ctx: ctxFor(db), packet: brokenPacket, client: fakeClient }),
    ).rejects.toThrow(/textRendering/);
    expect(create).not.toHaveBeenCalled();
  });
});
