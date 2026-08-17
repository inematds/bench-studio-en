import React, { useEffect, useMemo, useRef, useState } from "react";

const CONFIG = {
  website: {
    eyebrow: "Website builder",
    headline: "From brief to working site.",
    subhead: "Describe the brand, audience, and desired feeling. Bench builds the complete site locally, with source you can inspect and edit.",
    titleLabel: "Project name",
    titlePlaceholder: "Amethyst jewellery maison",
    briefPlaceholder: "A cinematic jewellery house built around raw amethyst. The opening should feel like entering a mineral formation, then settle into a precise black-and-violet product catalogue…",
    button: "Build website",
    templates: [
      ["immersive", "Immersive", "Spatial motion and strong art direction"],
      ["editorial", "Editorial", "Type-led, restrained, image-conscious"],
      ["product", "Product", "Commerce-ready hierarchy and product focus"],
    ],
  },
  document: {
    eyebrow: "Document builder",
    headline: "From brief to finished PDF.",
    subhead: "Describe the argument and audience. Bench creates the designed PDF, editable HTML source, and a verified local archive.",
    titleLabel: "Document title",
    titlePlaceholder: "The State of Creative AI",
    briefPlaceholder: "A 16-page field report for creative directors. Build a clear argument around the collapse of production cost, include an executive opening, four evidence chapters, and a practical closing playbook…",
    button: "Create document",
    templates: [
      ["editorial-report", "Editorial report", "Art-book pacing with substantive analysis"],
      ["presentation", "Presentation", "Landscape narrative designed for a room"],
      ["field-guide", "Field guide", "Practical, structured, and easy to scan"],
    ],
  },
};

async function json(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function CreativeStudio({ kind }) {
  const config = CONFIG[kind];
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [template, setTemplate] = useState(config.templates[0][0]);
  const [reasoning, setReasoning] = useState("low");
  const [projects, setProjects] = useState([]);
  const [reference, setReference] = useState(null);
  const loadReferenceRef = useRef(() => {});
  const [error, setError] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const active = useMemo(() => projects.find((project) => ["queued", "running"].includes(project.status)), [projects]);
  const completed = useMemo(() => projects.filter((project) => project.status === "complete"), [projects]);
  const failed = useMemo(() => projects.filter((project) => project.status === "failed"), [projects]);

  async function reviseProject(id, instruction) {
    try {
      const project = await json(`/api/projects/${id}/revise`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruction }) });
      setProjects((rows) => rows.map((row) => row.id === id ? project : row));
    } catch (e) { setError(String(e.message ?? e)); }
  }

  async function revertProject(id) {
    try {
      const project = await json(`/api/projects/${id}/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      setProjects((rows) => rows.map((row) => row.id === id ? project : row));
    } catch (e) { setError(String(e.message ?? e)); }
  }

  async function removeProject(id) {
    try {
      const response = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error);
      setProjects((rows) => rows.filter((row) => row.id !== id));
    } catch (e) { setError(String(e.message ?? e)); }
  }
  const history = useMemo(() => projects.filter((project) => !["complete", "queued", "running", "failed"].includes(project.status)), [projects]);

  useEffect(() => {
    setTemplate(config.templates[0][0]);
    setError("");
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let dead = false;
    const load = () => json(`/api/projects?kind=${kind}`).then((result) => {
      if (!dead) {
        setProjects(result.rows);
        setLibraryError("");
        setLoadingProjects(false);
      }
    }).catch(() => {
      if (!dead) {
        setLibraryError("The local project archive is unavailable. Bench will retry automatically.");
        setLoadingProjects(false);
      }
    });
    load();
    json("/api/creative-references").then((result) => !dead && setReference(result[kind])).catch(() => {});
    loadReferenceRef.current = () => json("/api/creative-references").then((r) => setReference(r[kind])).catch(() => {});
    const timer = setInterval(load, 1800);
    return () => { dead = true; clearInterval(timer); };
  }, [kind]);

  async function build() {
    setSubmitting(true);
    setError("");
    try {
      const project = await json("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, title, prompt, template, model: "gpt-5.6-sol", reasoning }),
      });
      setProjects((rows) => [project, ...rows]);
      setTitle("");
      setPrompt("");
    } catch (buildError) {
      setError(buildError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel(id) {
    const project = await json(`/api/projects/${id}/cancel`, { method: "POST" });
    setProjects((rows) => rows.map((row) => row.id === id ? project : row));
  }

  return (
    <section className={`creative-studio creative-${kind}`}>
      <header className="creative-head">
        <div>
          <div className="eyebrow">{config.eyebrow}</div>
          <h1>{config.headline}</h1>
          <p>{config.subhead}</p>
        </div>
      </header>

      <div className="creative-composer">
        <div className="creative-form">
          <label>
            <span>{config.titleLabel}</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={config.titlePlaceholder} />
          </label>
          <label>
            <span>Creative brief</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={config.briefPlaceholder} />
            <small>Name the audience, purpose, desired feeling, and anything the result must include.</small>
          </label>

          <fieldset className="direction-picker">
            <legend>Starting direction</legend>
            <div>
              {config.templates.map(([id, label, description]) => (
                <button type="button" key={id} className={template === id ? "active" : ""} onClick={() => setTemplate(id)}>
                  <strong>{label}</strong><span>{description}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="creative-submit-row">
            <div className="craft-control">
              <span>Build depth</span>
              <button type="button" className={reasoning === "low" ? "active" : ""} onClick={() => setReasoning("low")}>Fast</button>
              <button type="button" className={reasoning === "medium" ? "active" : ""} onClick={() => setReasoning("medium")}>Considered</button>
            </div>
            <button type="button" className="creative-primary" onClick={build} disabled={submitting || Boolean(active) || !title.trim() || prompt.trim().length < 20}>
              {submitting ? "Starting…" : active ? "Build in progress" : config.button}
            </button>
          </div>
          {error && <p className="creative-error" role="alert">{error}</p>}
        </div>

        <aside className="creative-reference">
          <div className="reference-frame">
            {kind === "website" && reference?.preview_url ? (
              <iframe title="Local website reference" src={reference.preview_url} loading="lazy" />
            ) : reference?.preview_url ? (
              <object title="Local document reference" data={reference.preview_url} type="application/pdf" />
            ) : <div className="reference-offline">Add an optional local reference in ~/.env.</div>}
          </div>
          <ReferenceConfig kind={kind} reference={reference} onSaved={() => loadReferenceRef.current()} />
          <div className="reference-copy">
            <span>Craft reference</span>
            <strong>{reference?.name ?? (kind === "website" ? "Local website reference" : "Local document reference")}</strong>
            <p>{reference?.description}</p>
            {reference?.preview_url && <a href={reference.preview_url} target="_blank" rel="noreferrer">Open reference ↗</a>}
          </div>
        </aside>
      </div>

      {active && <BuildProgress project={active} onCancel={() => cancel(active.id)} />}

      <section className="project-library">
        <div className="project-library-head">
          <div>
            <span className="project-library-kicker">Completed work</span>
            <h2>{kind === "website" ? "Your websites" : "Your documents"}</h2>
          </div>
          <span>{loadingProjects ? "Loading…" : libraryError ? "Archive offline" : kind === "website"
            ? `${completed.length} generated${reference?.preview_url ? " · 1 reference" : ""}`
            : `${completed.length} PDFs`}</span>
        </div>
        {libraryError ? (
          <div className="project-empty project-empty-error"><strong>Project archive offline</strong><span>{libraryError}</span></div>
        ) : loadingProjects ? (
          <div className="project-loading" aria-label="Loading local projects"><i /><i /><i /></div>
        ) : !completed.length && !(kind === "website" && reference?.preview_url) ? (
          <div className="project-empty">Your first completed {kind} will appear here with a live preview and its source files.</div>
        ) : (
          <div className="project-grid">
            {kind === "website" && reference?.preview_url && <WebsiteReferenceCard reference={reference} />}
            {completed.map((project) => <ProjectCard key={project.id} project={project} onDelete={removeProject} onRevise={reviseProject} onRevert={revertProject} />)}
          </div>
        )}

        {failed.length > 0 && (
          <div className="project-failed-list">
            {failed.map((project) => <FailedCard key={project.id} project={project} onDelete={removeProject} onRevise={reviseProject} onRevert={revertProject} />)}
          </div>
        )}

        {history.length > 0 && (
          <details className="project-history">
            <summary>Build history <span>{history.length}</span></summary>
            <div>
              {history.map((project) => (
                <article key={project.id}>
                  <div><strong>{project.title}</strong><span>{project.status} · {relativeTime(project.updated_at)}</span></div>
                  {project.error && <p>{project.error}</p>}
                </article>
              ))}
            </div>
          </details>
        )}
      </section>
    </section>
  );
}

// Uma build que falhou ainda deixa coisa em disco — e as vezes quase tudo. Some-la
// numa lista recolhida joga fora trabalho ja feito (e, num provedor pago, ja pago).
// Aqui o motivo real aparece inteiro e cada arquivo pode ser aberto e editado.
// Painel de arquivos + editor. Serve tanto para build concluida quanto para
// build que falhou: nos dois casos o que esta em disco e a unica verdade, e
// poder corrigir a mao evita refazer (e repagar) a geracao inteira por causa de
// um detalhe.
function ProjectFiles({ project, onRevise, onRevert }) {
  const [editing, setEditing] = useState(null);
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("");
  const [instruction, setInstruction] = useState("");
  const [sending, setSending] = useState(false);
  const produced = (project.files ?? []).filter((f) => !f.internal);
  const logs = (project.files ?? []).filter((f) => f.internal);

  async function openFile(file) {
    setStatus("");
    setEditing(file);
    try {
      const r = await fetch(`/api/projects/${project.id}/file?name=${encodeURIComponent(file.name)}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      setContent(j.content);
    } catch (e) { setStatus(String(e.message ?? e)); }
  }

  async function saveFile() {
    setStatus("Saving…");
    try {
      const r = await fetch(`/api/projects/${project.id}/file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editing.name, content }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      setStatus("Saved.");
    } catch (e) { setStatus(String(e.message ?? e)); }
  }

  async function revise() {
    if (instruction.trim().length < 4) return;
    setSending(true);
    try { await onRevise(project.id, instruction.trim()); setInstruction(""); }
    finally { setSending(false); }
  }

  return (
    <div className="project-files">
      {onRevise && (
        <div className="project-revise">
          <label htmlFor={`revise-${project.id}`}>Ask for a change</label>
          <textarea
            id={`revise-${project.id}`}
            rows={2}
            value={instruction}
            placeholder="e.g. make the background darker and enlarge the first section heading"
            onChange={(e) => setInstruction(e.target.value)}
          />
          <div className="project-revise-actions">
            <button type="button" className="project-revise-send" onClick={revise} disabled={sending || instruction.trim().length < 4}>
              {sending ? "Sending…" : "Apply change"}
            </button>
            {project.snapshots?.length > 0 && onRevert && (
              <button type="button" onClick={() => onRevert(project.id)} title={`Back to the state from ${relativeTime(project.snapshots[0].at)}`}>
                Undo last ({project.snapshots.length})
              </button>
            )}
            <span>Current files are copied before any change.</span>
          </div>
        </div>
      )}
            {!produced.length && <p className="modes-hint">No files were produced — the build stopped before writing.</p>}
            {produced.map((f) => (
              <button type="button" key={f.name} className="project-file" onClick={() => openFile(f)} disabled={!f.editable}>
                <b>{f.name}</b><small>{(f.size_bytes / 1024).toFixed(1)} kB</small>
              </button>
            ))}
            {project.bundle_url && (
              <a className="project-file project-file-download" href={`${project.bundle_url}?download=1`}>
                <b>Download all (.zip)</b><small>{produced.length} files</small>
              </a>
            )}
            {logs.length > 0 && (
              <details className="project-logs">
                <summary>Build log ({logs.length})</summary>
                {logs.map((f) => (
                  <button type="button" key={f.name} className="project-file" onClick={() => openFile(f)}>
                    <b>{f.name}</b><small>{(f.size_bytes / 1024).toFixed(1)} kB</small>
                  </button>
                ))}
              </details>
            )}
      {editing && (
        <div className="project-editor">
          <div className="project-editor-head">
            <strong>{editing.name}</strong>
            <div>
              <span>{status}</span>
              <button type="button" onClick={saveFile}>Save</button>
              <button type="button" onClick={() => { setEditing(null); setStatus(""); }}>Close</button>
            </div>
          </div>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
        </div>
      )}
    </div>
  );
}

function FailedCard({ project, onDelete, onRevise, onRevert }) {
  const [open, setOpen] = useState(false);
  const produced = (project.files ?? []).filter((f) => !f.internal);
  return (
    <article className="project-card project-card-failed">
      <div className="project-card-body">
        <div><span className="project-status failed">Build failed</span><small>{relativeTime(project.updated_at)}</small></div>
        <h3>{project.title}</h3>
        {project.error && <p className="project-failed-reason">{project.error}</p>}
        <div className="project-actions">
          <button type="button" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide files" : `Files (${produced.length})`}
          </button>
          {produced.some((f) => /index\.html?$/i.test(f.name)) && (
            <a className="project-open" href={`/projects/${project.id}/index.html`} target="_blank" rel="noreferrer">Open anyway ↗</a>
          )}
          {onDelete && <DeleteProject project={project} onDelete={onDelete} />}
        </div>
        {open && <ProjectFiles project={project} onRevise={onRevise} onRevert={onRevert} />}
      </div>
    </article>
  );
}

// Apagar e irreversivel e leva os arquivos do disco junto, entao pede confirmacao
// no lugar de um clique solto ao lado de "Open".
function DeleteProject({ project, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!confirming) return <button type="button" className="project-delete" onClick={() => setConfirming(true)}>Delete</button>;
  return (
    <span className="project-delete-confirm">
      <span>Delete “{project.title}” and its files?</span>
      <button type="button" onClick={() => setConfirming(false)} disabled={busy}>Keep</button>
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={async () => { setBusy(true); try { await onDelete(project.id); } finally { setBusy(false); } }}
      >{busy ? "Deleting…" : "Delete"}</button>
    </span>
  );
}

// A referencia de craft e um alvo de qualidade, nao um molde: o construtor pode
// olhar para calibrar acabamento e e proibido de copiar marca, texto, estrutura
// ou assets. Antes so dava para apontar por variavel de ambiente, o que exigia
// editar arquivo e reiniciar — e por isso ficava vazia para sempre.
function ReferenceConfig({ kind, reference, onSaved }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPath(reference?.path ?? "");
    setUrl(reference?.url ?? "");
  }, [reference?.path, reference?.url]);

  async function save() {
    setSaving(true);
    setStatus("");
    try {
      const body = kind === "website"
        ? { website_reference: path, website_reference_url: url }
        : { document_reference: path };
      await json("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      await onSaved();
      setStatus("Saved.");
      setOpen(false);
    } catch (e) { setStatus(String(e.message ?? e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="reference-config">
      <button type="button" className="reference-config-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "Close" : reference?.path ? "Change reference" : "Set a reference"}
      </button>
      {reference?.path && !open && (
        <span className={`reference-state${reference.exists ? "" : " missing"}`}>
          {reference.exists ? reference.path : `not found: ${reference.path}`}
        </span>
      )}
      {open && (
        <div className="reference-config-form">
          <label>
            <span>{kind === "website" ? "Path to a site of yours (folder or index.html)" : "Path to a document of yours (.html or .pdf)"}</span>
            <input value={path} placeholder="/home/you/projects/site/guia/index.html" onChange={(e) => setPath(e.target.value)} />
          </label>
          {kind === "website" && (
            <label>
              <span>Preview URL (optional — only used to render the panel above)</span>
              <input value={url} placeholder="http://localhost:5300/" onChange={(e) => setUrl(e.target.value)} />
            </label>
          )}
          <div className="reference-config-actions">
            <button type="button" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            <button type="button" onClick={() => { setPath(""); setUrl(""); }}>Clear</button>
            {status && <span>{status}</span>}
          </div>
          <p>The builder is told it may inspect this for craft and interaction ideas, and that it must not copy brand, text, structure or assets. Model engines (local Qwen, OpenRouter) receive the file content inline, since they cannot open files.</p>
        </div>
      )}
    </div>
  );
}

function WebsiteReferenceCard({ reference }) {
  return (
    <article className="project-card project-reference-card">
      <div className="project-preview">
        <iframe title={`${reference.name} craft reference`} src={reference.preview_url} loading="lazy" />
        <span className="project-type project-type-reference">Craft reference</span>
      </div>
      <div className="project-card-body">
        <div><span className="project-status">Reference</span><small>Design benchmark</small></div>
        <h3>{reference.name}</h3>
        <p>{reference.description}</p>
        <div className="project-actions">
          <a className="project-open" href={reference.preview_url} target="_blank" rel="noreferrer">Open reference</a>
        </div>
      </div>
    </article>
  );
}

function BuildProgress({ project, onCancel }) {
  return (
    <section className="build-progress" aria-live="polite">
      <div className="build-progress-copy"><span>Building now</span><strong>{project.title}</strong><small>{project.stage}</small></div>
      <div className="build-meter"><i style={{ width: `${Math.max(3, project.progress)}%` }} /></div>
      <b>{project.progress}%</b>
      <button type="button" onClick={onCancel}>Cancel</button>
    </section>
  );
}

function ProjectCard({ project, onDelete, onRevise, onRevert }) {
  const [showFiles, setShowFiles] = useState(false);
  const complete = project.status === "complete";
  const isWebsite = project.kind === "website";
  const resultUrl = isWebsite ? project.preview_url : project.artifact_file;
  return (
    <article className={`project-card status-${project.status}`}>
      <div className="project-preview">
        {complete && isWebsite && project.preview_url ? (
          <iframe title={`${project.title} website preview`} src={project.preview_url} loading="lazy" />
        ) : complete && project.artifact_file ? (
          <object title={`${project.title} PDF preview`} data={`${project.artifact_file}#page=1&view=FitH`} type="application/pdf">
            <a href={project.artifact_file}>Open {project.title}</a>
          </object>
        ) : <span>{project.progress}%</span>}
        {complete && <span className="project-type">{isWebsite ? "Live site" : "PDF"}</span>}
      </div>
      <div className="project-card-body">
        <div><span className="project-status">Ready</span><small>{relativeTime(project.updated_at)}</small></div>
        <h3>{project.title}</h3>
        <p>{project.prompt}</p>
        <div className="project-actions">
          {complete && resultUrl && <a className="project-open" href={resultUrl} target="_blank" rel="noreferrer">{isWebsite ? "Open site" : "Open PDF"}</a>}
          {complete && !isWebsite && project.artifact_file && <a href={project.artifact_file} download>Download</a>}
          {complete && !isWebsite && project.preview_url && <a href={project.preview_url} target="_blank" rel="noreferrer">Editable HTML</a>}
          {complete && (
            <button type="button" onClick={() => setShowFiles((v) => !v)}>
              {showFiles ? "Hide source" : `Source (${(project.files ?? []).filter((f) => !f.internal).length})`}
            </button>
          )}
          {onDelete && <DeleteProject project={project} onDelete={onDelete} />}
          {project.status === "failed" && <span title={project.error}>Build failed</span>}
        </div>
        {showFiles && <ProjectFiles project={project} onRevise={onRevise} onRevert={onRevert} />}
      </div>
    </article>
  );
}
