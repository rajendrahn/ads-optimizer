// D6 — Firebase Auth sign-in screen. Email/password only (matches seedDemo.ts's own seeded Auth
// emulator user for local dev) — nothing about the API's own auth boundary (server.ts) depends on
// which Firebase Auth provider was used to obtain the ID token, so this is the simplest one to
// build a working local demo against; an operator can add other providers without touching the
// API at all.

import { useState, type FormEvent } from "react";
import { useAuth } from "../hooks/useAuth.ts";

export function SignIn() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sign-in">
      <form onSubmit={(e) => void handleSubmit(e)}>
        <h1>Ads Optimizer</h1>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
        {error && (
          <p className="sign-in__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
