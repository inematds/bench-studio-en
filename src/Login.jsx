import React, { useState } from "react";

// Shown only when a password is configured and this browser has no session.
// With no password set, this screen never appears.

export default function Login({ onDone }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Wrong password.");
      onDone();
    } catch (e) {
      setError(String(e.message ?? e));
      setPassword("");
    } finally { setBusy(false); }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">Bench<small>studio</small></div>
        <h1>This studio is locked.</h1>
        <p>Enter the password to continue.</p>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          autoComplete="current-password"
          aria-label="Studio password"
          disabled={busy}
        />
        {error && <p className="config-alert danger" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !password}>{busy ? "Checking…" : "Enter"}</button>

        <p className="login-hint">
          Forgot it? Remove <code>BENCH_PASSWORD</code> from the project's <code>.env</code> on the machine
          running the studio, or run <code>npm run set-password</code>, then restart.
        </p>
      </form>
    </div>
  );
}
