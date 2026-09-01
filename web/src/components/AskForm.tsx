// D6 — "ask a question, get a recommendation card" (D6's own Goal line). Submits without a page
// reload — App.tsx wires the returned id straight into useRecommendation's live subscription.

import { useState, type FormEvent } from "react";
import { createRecommendation } from "../api/client.ts";
import type { ScalableEntityType } from "../api/types.ts";

export function AskForm({ onCreated }: { onCreated: (recommendationId: string) => void }) {
  const [type, setType] = useState<ScalableEntityType>("ADSET");
  const [id, setId] = useState("");
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (id.trim().length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const { recommendationId } = await createRecommendation(
        { type, id: id.trim() },
        question.trim() || null,
      );
      onCreated(recommendationId);
      setQuestion("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="ask-form" onSubmit={(e) => void handleSubmit(e)}>
      <div className="ask-form__row">
        <label>
          Entity type
          <select value={type} onChange={(e) => setType(e.target.value as ScalableEntityType)}>
            <option value="AD">Ad</option>
            <option value="ADSET">Ad set</option>
            <option value="CAMPAIGN">Campaign</option>
          </select>
        </label>
        <label>
          Entity ID
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. AS_17"
            required
          />
        </label>
      </div>
      <label>
        Question (optional)
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Should I increase the budget?"
        />
      </label>
      <button type="submit" disabled={submitting}>
        {submitting ? "Asking…" : "Ask"}
      </button>
      {error && (
        <p className="ask-form__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
