// D6 — top-level app shell. Gates on Firebase Auth (§17.1's client half); once signed in, every
// data fetch goes through web/src/api/client.ts, which is the only place this app talks to the
// network — never a direct Firestore read (see firebase.ts's own comment).

import { useState } from "react";
import { useAuth } from "./hooks/useAuth.ts";
import { useRecommendation } from "./hooks/useRecommendation.ts";
import { SignIn } from "./components/SignIn.tsx";
import { AskForm } from "./components/AskForm.tsx";
import { RecommendationList } from "./components/RecommendationList.tsx";
import { RecommendationCard } from "./components/RecommendationCard.tsx";

export function App() {
  const { user, loading, signOut } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const { view, streamError, refresh } = useRecommendation(selectedId);

  if (loading) return <p className="app__loading">Loading…</p>;
  if (!user) return <SignIn />;

  return (
    <div className="app">
      <header className="app__header">
        <h1>Ads Optimizer</h1>
        <span className="app__user">
          {user.email}{" "}
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </span>
      </header>

      <main className="app__main">
        <aside className="app__sidebar">
          <AskForm
            onCreated={(id) => {
              setSelectedId(id);
              setRefreshToken((t) => t + 1);
            }}
          />
          <RecommendationList
            selectedId={selectedId}
            onSelect={setSelectedId}
            refreshToken={refreshToken}
          />
        </aside>

        <section className="app__content">
          {streamError && (
            <p className="app__stream-error" role="alert">
              Live updates interrupted: {streamError}
            </p>
          )}
          {view ? (
            <RecommendationCard
              view={view}
              onDecided={() => {
                refresh();
                setRefreshToken((t) => t + 1);
              }}
            />
          ) : (
            <p className="app__empty">
              Ask a question about an ad, ad set, or campaign to get started.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
