import React, { useEffect, useMemo, useRef, useState } from "react";

// Results, big. Each one keeps its own price and billing confidence.

const FORMAT_LABELS = {
  ugc: "UGC ad",
  unboxing: "Unboxing",
  hypermotion: "Hyper motion",
  tvspot: "TV spot",
  product: "Product still",
  poster: "Ad with headline",
};

// As opcoes de filtro saem dos proprios resultados: um provedor ou modelo que
// voce nunca usou nao tem por que ocupar espaco na barra.
function optionsFrom(shots, pick) {
  const counts = new Map();
  for (const shot of shots) {
    const value = pick(shot);
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export default function Work({ job, shots, standalone = false, onDelete, onReuse }) {
  const [kind, setKind] = useState("all");
  const [provider, setProvider] = useState("all");
  const [model, setModel] = useState("all");

  const kinds = useMemo(() => optionsFrom(shots, (s) => s.kind), [shots]);
  const providers = useMemo(() => optionsFrom(shots, (s) => s.provider ?? "fal"), [shots]);
  // A lista de modelos acompanha os outros filtros: escolhido o provedor, nao
  // faz sentido oferecer modelos que nao sao dele.
  const models = useMemo(() => optionsFrom(
    shots.filter((s) => (kind === "all" || s.kind === kind) && (provider === "all" || (s.provider ?? "fal") === provider)),
    (s) => s.model,
  ), [shots, kind, provider]);

  const filtered = useMemo(() => shots.filter((s) =>
    (kind === "all" || s.kind === kind)
    && (provider === "all" || (s.provider ?? "fal") === provider)
    && (model === "all" || s.model === model)
  ), [shots, kind, provider, model]);

  // Um modelo escolhido pode deixar de existir na lista quando o provedor muda;
  // sem isto o filtro ficaria travado num resultado vazio, sem explicacao.
  useEffect(() => {
    if (model !== "all" && !models.some(([value]) => value === model)) setModel("all");
  }, [models, model]);

  const filtering = kind !== "all" || provider !== "all" || model !== "all";
  const spent = filtered.reduce((a, s) => a + (Number(s.cost) || 0), 0);

  return (
    <div className={`wall results-wall${standalone ? " standalone" : ""}`}>
      <div className="wall-head">
        <h2>{standalone ? "Library" : "Your results"}</h2>
        <span>{filtered.length}{filtering ? ` of ${shots.length}` : ""} {filtered.length === 1 ? "result" : "results"}</span>
        <div className="rule" />
        <span>${spent.toFixed(3)} spent</span>
      </div>

      {shots.length > 1 && (
        <div className="results-filters" role="group" aria-label="Filtrar resultados">
          <Filter label="Type" value={kind} onChange={setKind} options={kinds} total={shots.length} />
          <Filter label="Provider" value={provider} onChange={setProvider} options={providers} total={shots.length} />
          {models.length > 1 && <Filter label="Model" value={model} onChange={setModel} options={models} total={filtered.length} wide />}
          {filtering && (
            <button type="button" className="results-filter-clear" onClick={() => { setKind("all"); setProvider("all"); setModel("all"); }}>
              Clear
            </button>
          )}
        </div>
      )}

      {!job && !shots.length ? (
        <div className="results-empty">
          <strong>No results yet</strong>
          <span>Your generated images and videos will appear here.</span>
          <a href="#create">Create your first shot</a>
        </div>
      ) : (
        <div className="masonry">
          {job && <Job job={job} />}
          {filtered.map((s) => (
            <Shot key={`${s.archive_id ?? s.request_id}-${s.at}`} shot={s} onDelete={onDelete} onReuse={onReuse} />
          ))}
        </div>
      )}
    </div>
  );
}

function Filter({ label, value, onChange, options, total, wide }) {
  if (!options.length) return null;
  return (
    <label className={`results-filter${wide ? " wide" : ""}`}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="all">All ({total})</option>
        {options.map(([option, count]) => (
          <option key={option} value={option}>{option} ({count})</option>
        ))}
      </select>
    </label>
  );
}

function Job({ job }) {
  return (
    <div className="job">
      <div className="ph pulse">{job.status ?? job.phase}</div>
      <div className="meta">
        <span>{job.model ?? ""}</span>
        <span>
          {job.queue_position != null ? `queue ${job.queue_position}` : ""}
          {job.estimate?.cost != null ? ` · ~$${job.estimate.cost.toFixed(3)}` : ""}
        </span>
      </div>
      <div className="bar-lite"><i /></div>
    </div>
  );
}

function Shot({ shot, onDelete, onReuse }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const verified = shot.cost_confidence === "verified";
  const formatLabel = FORMAT_LABELS[shot.format];
  const idea = String(shot.raw_idea || shot.prompt || "").trim();
  const resultLabel = shot.label || "Untitled result";
  // `params` carrega o prompt junto porque e o payload enviado ao provider; aqui
  // interessa so o que e ajuste de controle.
  //
  // E carrega tambem as REFERENCIAS. Quando a referencia foi enviada como data
  // URI, o valor e o arquivo inteiro em base64 — 2 MB de texto que apareciam
  // despejados na tela de detalhes. Media ja tem lugar proprio logo abaixo (as
  // miniaturas), entao aqui ela nunca deve virar texto.
  const reusableParams = Object.entries(shot.params ?? {})
    .filter(([name, value]) => {
      if (name === "prompt") return false;
      const text = String(value ?? "");
      if (text.startsWith("data:")) return false;
      if (/^https?:\/\//.test(text) && /image|video|\.(png|jpe?g|webp|mp4|mov)/i.test(text)) return false;
      return text.length <= 300;
    });

  async function removeResult() {
    setDeleting(true);
    try {
      await onDelete?.(shot);
    } finally {
      setDeleting(false);
    }
  }
  return (
    <div className="work">
      {shot.outputs.map((o, i) => {
        const source = o.local_url || o.url;
        const isVideo =
          String(o.content_type ?? "").startsWith("video") || /\.mp4($|\?)/.test(source);
        return isVideo ? (
          <VideoPreview key={i} src={source} />
        ) : (
          <img key={i} src={source} alt={resultLabel} loading="lazy" />
        );
      })}

      <span className="work-tag" title={shot.cost_basis}>
        <span className={`dot ${verified ? "verified" : "estimated"}`} />
        {verified ? "Billed" : "Est."} ${Number(shot.cost ?? 0).toFixed(3)}
      </span>

      <div className="work-foot">
        <div className="l">
          <div className="work-title">
            <span className="work-name">{resultLabel}</span>
            {formatLabel && <span className="work-format">{formatLabel}</span>}
          </div>
          <div className="work-actions">
            <button type="button" onClick={() => setDetailsOpen((value) => !value)} aria-expanded={detailsOpen}>
              {detailsOpen ? "Hide details" : "Details"}
            </button>
            {onReuse && (
              <button type="button" onClick={() => onReuse(shot)} aria-label={`Reuse settings from ${resultLabel}`} title="Carrega modelo, prompt, controles e referencias deste resultado no Create">
                Redo
              </button>
            )}
            <a href={shot.outputs[0]?.local_url || shot.outputs[0]?.url} download aria-label={`Download ${resultLabel}`}>Download</a>
            {onDelete && shot.archive_id && (
              <button type="button" className="work-delete" onClick={() => setConfirmingDelete(true)} aria-label={`Delete ${resultLabel}`}>
                Delete
              </button>
            )}
          </div>
        </div>
        <div className="p">{idea}</div>
        {detailsOpen && (
          <div className="work-details">
            <dl>
              <div><dt>Model</dt><dd>{shot.label}</dd></div>
              <div><dt>Cost</dt><dd>{verified ? "Verified billed amount" : "Estimate"} · ${Number(shot.cost ?? 0).toFixed(4)}</dd></div>
              {shot.request_id && <div><dt>Request</dt><dd>{shot.request_id}</dd></div>}
              <div><dt>Archive</dt><dd>{shot.outputs.some((output) => output.local_url) ? "Saved locally" : "Remote copy only"}</dd></div>
            </dl>
            {shot.raw_idea && shot.raw_idea !== shot.prompt && (
              <>
                <strong>Your idea</strong>
                <p>{shot.raw_idea}</p>
              </>
            )}
            <strong>Prompt sent</strong>
            <p>{shot.prompt}</p>
            {reusableParams.length > 0 && (
              <>
                <strong>Settings</strong>
                <dl>
                  {reusableParams.map(([name, value]) => (
                    <div key={name}><dt>{name.replace(/_/g, " ")}</dt><dd>{String(value)}</dd></div>
                  ))}
                </dl>
              </>
            )}
            {shot.input_assets?.length > 0 && (
              <>
                <strong>References used ({shot.input_assets.length})</strong>
                <div className="work-refs">
                  {shot.input_assets.map((asset, i) => (
                    <img key={i} src={asset.local_url || asset.url} alt={`Reference ${i + 1}`} loading="lazy" />
                  ))}
                </div>
              </>
            )}
            {onReuse && (
              <button type="button" className="work-reuse-wide" onClick={() => onReuse(shot)}>
                Redo with these exact settings
              </button>
            )}
            {shot.outputs[0]?.remote_url && <a className="hosted-copy" href={shot.outputs[0].remote_url} target="_blank" rel="noreferrer">Open fal-hosted copy ↗</a>}
          </div>
        )}
        {confirmingDelete && (
          <div className="work-delete-confirm" role="group" aria-label={`Confirm deletion of ${resultLabel}`}>
            <div>
              <strong>Delete this result?</strong>
              <span>Removes it from Bench and deletes the local copy. The fal-hosted copy may remain.</span>
            </div>
            <div>
              <button type="button" onClick={() => setConfirmingDelete(false)} disabled={deleting}>Keep it</button>
              <button type="button" className="danger" onClick={removeResult} disabled={deleting}>
                {deleting ? "Deleting…" : "Delete result"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function VideoPreview({ src }) {
  const videoRef = useRef(null);
  const soundEnabledRef = useRef(false);
  const [soundEnabled, setSoundEnabled] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    video.defaultMuted = true;
    video.muted = true;

    const scrollRoot = document.querySelector(".scroll");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (!soundEnabledRef.current) video.muted = true;
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { root: scrollRoot, rootMargin: "120px 0px", threshold: 0.35 }
    );

    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    soundEnabledRef.current = soundEnabled;
    if (!video) return;
    video.muted = !soundEnabled;
    if (soundEnabled && video.volume === 0) video.volume = 1;
  }, [soundEnabled]);

  const keepSoundIntentional = (event) => {
    const video = event.currentTarget;
    if (!soundEnabledRef.current && !video.muted) {
      video.muted = true;
    } else if (soundEnabledRef.current && video.muted) {
      setSoundEnabled(false);
    }
  };

  return (
    <div className="work-video-shell">
      <video
        ref={videoRef}
        className="work-video"
        src={src}
        controls
        loop
        muted={!soundEnabled}
        playsInline
        preload="metadata"
        onVolumeChange={keepSoundIntentional}
        aria-label="Generated video preview"
      />
      <button
        type="button"
        className={`work-sound-toggle${soundEnabled ? " enabled" : ""}`}
        onClick={() => setSoundEnabled((enabled) => !enabled)}
        aria-pressed={soundEnabled}
        aria-label={soundEnabled ? "Mute this video" : "Unmute this video"}
      >
        {soundEnabled ? "Sound on" : "Muted"}
      </button>
    </div>
  );
}
