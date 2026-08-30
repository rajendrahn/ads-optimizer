// AI collections — §8: aiConversations, accountMemory.
//
// §21.3 describes these only briefly ("Account memory — longer-term learned patterns,
// grounded in statistics... Conversation memory — recent questions and prior
// recommendations, for conversational continuity only") and no step in
// IMPLEMENTATION_PLAN.md claims them as an explicit deliverable yet (D3 touches
// conversational follow-up per §26's flow; account memory belongs to Phase F per the
// deferred-work table). This is the thinnest schema in this directory for that reason —
// enough shape to deny-all rules-test against and to unblock whichever step needs it,
// without inventing fields the design never specified.

import { z } from "zod";
import { firestoreTimestamp } from "./common.ts";

export const aiConversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: firestoreTimestamp,
});
export type AiConversationMessage = z.infer<typeof aiConversationMessageSchema>;

export const aiConversationSchema = z.object({
  conversationId: z.string().min(1),
  userId: z.string().nullable(),
  messages: z.array(aiConversationMessageSchema),
  relatedRecommendationIds: z.array(z.string()).nullable(),
  createdAt: firestoreTimestamp,
  updatedAt: firestoreTimestamp,
});
export type AiConversation = z.infer<typeof aiConversationSchema>;

export const accountMemorySchema = z.object({
  memoryId: z.string().min(1),
  scope: z.enum(["ACCOUNT", "ENTITY"]), // §21.3
  entityId: z.string().nullable(), // set when scope === "ENTITY"
  pattern: z.string(), // the learned-pattern statement, grounded in statistics per §21.3
  supportingStats: z.record(z.string(), z.unknown()).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  createdAt: firestoreTimestamp,
  updatedAt: firestoreTimestamp,
});
export type AccountMemory = z.infer<typeof accountMemorySchema>;
