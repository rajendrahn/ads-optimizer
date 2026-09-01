// D6 — recent-questions panel, backed by GET /api/recommendations (never a direct Firestore
// query from the browser).

import { useEffect, useState } from "react";
import { listRecommendations } from "../api/client.ts";
import type { RecommendationSummary } from "../api/types.ts";

export function RecommendationList({
  selectedId,
  onSelect,
  refreshToken,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  refreshToken: number;
}) {
  const [items, setItems] = useState<RecommendationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRecommendations()
      .then((res) => {
        if (!cancelled) setItems(res.recommendations);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  if (error) return <p className="rec-list__error">{error}</p>;

  return (
    <ul className="rec-list">
      {items.map((item) => (
        <li key={item.recommendationId}>
          <button
            type="button"
            className={
              item.recommendationId === selectedId
                ? "rec-list__item rec-list__item--selected"
                : "rec-list__item"
            }
            onClick={() => onSelect(item.recommendationId)}
          >
            <span className="rec-list__entity">
              {item.namedEntity
                ? `${item.namedEntity.type.toLowerCase()} ${item.namedEntity.id}`
                : "—"}
            </span>
            <span className="rec-list__status" data-status={item.status}>
              {item.status}
            </span>
            <span className="rec-list__question">{item.requestedQuestion}</span>
          </button>
        </li>
      ))}
      {items.length === 0 && <li className="rec-list__empty">No questions asked yet.</li>}
    </ul>
  );
}
