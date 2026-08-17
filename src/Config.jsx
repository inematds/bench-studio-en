import React, { useCallback, useEffect, useState } from "react";

// What the studio needs in order to work, and where each piece came from.
//
// This screen never receives a secret. The server sends presence, origin and a
// four-character tail; the values themselves stay on disk, behind the operating
// system's permissions. An input left untouched sends nothing.

const SOURCE_LABEL = {
  exported: "shell environment",
  project_env: ".env",
  home_env: "~/.env",
};

export default function Config({ onClose }) {
  const [state, setState] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [tests, setTests] = useState({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error(`Could not read configuration (${res.status})`);
      setState(await res.json());
    } catch (e) { setError(String(e.message ?? e)); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save() {
    // An empty box for a secret means "keep what is there", never "delete it" —
    // the box starts empty by design (we never receive the value), so treating
    // empty as a delete would wipe a key on a stray keystroke. Clearing a secret
    // is done in the .env file itself, where the intent is unambiguous.
    const secret = new Set((state?.fields ?? []).filter((f) => f.secret).map((f) => f.key));
    const patch = Object.fromEntries(
      Object.entries(drafts).filter(([k, v]) => v !== undefined && !(secret.has(k) && v.trim() === "")),
    );
    if (!Object.keys(patch).length) { setNotice("Nothing changed."); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);
      setState(body);
      setDrafts({});
      setNotice(`Saved to .env. Restart the server for the change to take effect — half of it is read at boot.`);
    } catch (e) { setError(String(e.message ?? e)); }
    finally { setBusy(false); }
  }

  async function testProvider(id) {
    setTests((t) => ({ ...t, [id]: { testing: true } }));
    try {
      const res = await fetch(`/api/config/test/${id}`, { method: "POST" });
      const body = await res.json();
      setTests((t) => ({ ...t, [id]: body }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { available: false, reason: String(e.message ?? e) } }));
    }
  }

  if (!state && !error) return <aside className="sheet"><div className="sheet-body"><p>Loading configuration…</p></div></aside>;

  const readOnly = state && !state.writable;

  return (
    <aside className="sheet config-sheet">
      <div className="sheet-head">
        <div className="sheet-title">
          <h3>Configuration</h3>
          <span>Keys, local models and paths. Values are never sent to this screen.</span>
        </div>
        <span className="spacer" />
        <button type="button" className="ghost-btn" onClick={onClose}>Close</button>
      </div>

      <div className="sheet-body">
        {error && <p className="config-alert danger" role="alert">{error}</p>}
        {notice && <p className="config-alert" role="status">{notice}</p>}

        {state?.lan_exposed && (
          <p className="config-alert danger" role="alert">
            <strong>This studio is published on your local network and has no authentication.</strong>{" "}
            Anyone who reaches this port can generate with your keys and read your history. Reach it over
            Tailscale or a password-protected proxy instead of an open port.
          </p>
        )}

        {readOnly && (
          <p className="config-alert danger" role="alert">
            <strong>Read-only from here.</strong> Settings can only be changed from the machine running the
            studio. This request came from the network.
          </p>
        )}

        <p className="config-note">
          Reading order: what the shell exported wins, then <code>.env</code> in the project, then <code>~/.env</code>.
          Saving writes <code>{state?.project_env_path}</code> with owner-only permissions.
        </p>

        <PasswordCard state={state} readOnly={readOnly} onChanged={load} />

        {state?.groups.map((group) => {
          const fields = state.fields.filter((f) => f.group === group.id);
          if (!fields.length) return null;
          return (
            <section key={group.id} className="config-group">
              <h4>{group.label}</h4>
              <p className="config-note">{group.note}</p>

              {fields.filter((f) => f.key !== "BENCH_PASSWORD").map((field) => (
                <ConfigField
                  key={field.key}
                  field={field}
                  draft={drafts[field.key]}
                  readOnly={readOnly}
                  onDraft={(v) => setDrafts((d) => ({ ...d, [field.key]: v }))}
                  test={tests[providerOf(field.key)]}
                  onTest={providerOf(field.key) ? () => testProvider(providerOf(field.key)) : null}
                  live={state.providers?.[providerOf(field.key)]}
                />
              ))}
            </section>
          );
        })}

        <div className="config-actions">
          <button type="button" onClick={save} disabled={busy || readOnly}>
            {busy ? "Saving…" : "Save to .env"}
          </button>
          <button type="button" className="ghost-btn" onClick={() => { setDrafts({}); setNotice(null); setError(null); }} disabled={busy}>
            Discard changes
          </button>
        </div>
      </div>
    </aside>
  );
}

// The password is not an env var like the others: you type a password and what
// gets stored is a hash of it, so it has its own action and its own endpoint.
function PasswordCard({ state, readOnly, onChanged }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const active = state?.fields?.find((f) => f.key === "BENCH_PASSWORD")?.present;

  async function send(password) {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const res = await fetch("/api/config/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
      setValue("");
      setMsg(body.message);
      onChanged();
    } catch (e) { setErr(String(e.message ?? e)); }
    finally { setBusy(false); }
  }

  return (
    <section className="config-group">
      <h4>Access</h4>
      <p className="config-note">
        The studio ships with no password, on purpose: talking to your own machine should not need one.
        A password protects the API — models, results, media, ledger and settings. The interface shell is
        still served to anyone who reaches the port, but without a session it shows nothing.
      </p>

      <div className={`config-field ${active ? "set" : "missing"}`}>
        <div className="config-field-head">
          <strong>Studio password</strong>
          <code>BENCH_PASSWORD</code>
          <span className="spacer" />
          <span className={`config-badge ${active ? "on" : "off"}`}>{active ? "password set" : "no password"}</span>
        </div>
        <p className="config-note">
          Stored as a scrypt hash — the password itself is never written down, so nobody reads it out of
          the file. Setting or changing it signs everyone else out immediately.
        </p>

        {msg && <p className="config-alert" role="status">{msg}</p>}
        {err && <p className="config-alert danger" role="alert">{err}</p>}

        <div className="config-field-edit">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={active ? "type a new password to replace it" : "at least 4 characters"}
            disabled={readOnly || busy}
            autoComplete="new-password"
            aria-label="Studio password"
          />
          <button type="button" className="ghost-btn small" onClick={() => send(value)} disabled={readOnly || busy || value.length < 4}>
            {active ? "Replace" : "Set password"}
          </button>
          {active && (
            <button type="button" className="ghost-btn small" onClick={() => send("")} disabled={readOnly || busy}>
              Remove
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// Which provider a key belongs to, for the "Test" button. A key with no
// provider (a path, a port) has nothing to ping.
function providerOf(key) {
  if (key === "FAL_KEY") return "fal";
  if (key === "AGNES_API_KEY") return "agnes";
  if (key === "KIE_API_KEY") return "kie";
  if (key === "INEMAIMG_URL") return "inemaimg";
  return null;
}

// Um endereco em valor padrao continua testavel: e justamente ali que "esta no
// ar?" e a pergunta que importa, porque ninguem digitou nada.
function ConfigField({ field, draft, readOnly, onDraft, onTest, test, live }) {
  const changed = draft !== undefined;
  const estado = field.present ? (field.shadowed ? "shadowed" : "set") : "missing";

  return (
    <div className={`config-field ${estado}`}>
      <div className="config-field-head">
        <strong>{field.label}</strong>
        <code>{field.key}</code>
        <span className="spacer" />
        {field.present ? (
          <span className="config-badge on">
            set{field.masked_tail ? ` ${field.masked_tail}` : ""} · {SOURCE_LABEL[field.source] ?? field.source}
          </span>
        ) : field.using_fallback ? (
          <span className="config-badge">using default {field.fallback}</span>
        ) : (
          <span className="config-badge off">not set</span>
        )}
        {onTest && (
          <button type="button" className="ghost-btn small" onClick={onTest} disabled={!field.present && !field.using_fallback}>
            {test?.testing ? "Testing…" : "Test"}
          </button>
        )}
      </div>

      <p className="config-note">{field.effect}</p>

      {field.shadowed && (
        <p className="config-alert danger">
          The shell exported a different value for this key, and the shell wins. Saving here changes the file
          but not what the studio is using — that needs a restart without that export (your <code>dev.sh</code> sets
          several of these).
        </p>
      )}

      {(test && !test.testing) && (
        <p className={`config-alert${test.available ? "" : " danger"}`}>
          {test.available ? "Answered — this provider is reachable." : `Failed: ${test.reason ?? "no answer"}`}
        </p>
      )}
      {!test && live && live.available === false && (
        <p className="config-alert danger">Currently unavailable: {live.reason}{live.hint ? ` — ${live.hint}` : ""}</p>
      )}

      <div className="config-field-edit">
        <input
          type={field.secret ? "password" : "text"}
          value={changed ? draft : (field.secret ? "" : (field.value ?? ""))}
          placeholder={field.secret ? (field.present ? "leave empty to keep the current key" : "paste the key") : "not set"}
          onChange={(e) => onDraft(e.target.value)}
          disabled={readOnly}
          autoComplete="off"
          spellCheck={false}
          aria-label={field.label}
        />
        {field.help && <a href={field.help} target="_blank" rel="noreferrer">where to get it</a>}
        {changed && <span className="config-badge on">will be saved</span>}
      </div>
    </div>
  );
}
