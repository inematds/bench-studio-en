import React, { useEffect, useMemo, useRef, useState } from "react";
import TopBar from "./TopBar.jsx";
import PromptBar, { SHOT_DIRECTION } from "./PromptBar.jsx";
import ModelWall from "./ModelWall.jsx";
import Work from "./Work.jsx";
import Ledger from "./Ledger.jsx";
import Tooling from "./Tooling.jsx";
import Modes from "./Modes.jsx";
import CreativeStudio from "./CreativeStudio.jsx";
import Config from "./Config.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";
import Login from "./Login.jsx";
import { assignInputFields, imageInputFor, mediaInputsFor, mediaTypeForFile, pairedImageModel, retainCompatibleAssets, sortModels } from "./modelCatalog.js";

function viewFromHash() {
  const view = window.location.hash.slice(1);
  return ["create", "websites", "documents", "models", "work", "modes", "connect"].includes(view) ? view : "create";
}

// Params driven by the schema but kept off the bar. Model defaults are already
// right for concepting, and a wall of knobs is what makes these tools feel like
// software instead of a camera.
const HIDE = new Set([
  "seed", "enable_safety_checker", "output_format", "image_url", "image_urls",
  "guidance_scale", "num_inference_steps", "negative_prompt", "num_frames", "style",
]);

// A creation mode is also a delivery intent. Keep the first frame useful for
// that intent, while still respecting the exact ratios each endpoint exposes.
// The user can change the chip at any time; these are only the starting points.
const FORMAT_FRAME_PREFERENCES = {
  ugc: {
    aspect_ratio: ["9:16", "3:4", "2:3", "1:1", "4:5", "16:9"],
    image_size: ["portrait_16_9", "portrait_4_3", "square_hd", "square"],
  },
  unboxing: {
    aspect_ratio: ["9:16", "3:4", "2:3", "1:1", "4:5", "16:9"],
    image_size: ["portrait_16_9", "portrait_4_3", "square_hd", "square"],
  },
  product: {
    aspect_ratio: ["1:1", "4:5", "4:3", "3:2", "square", "16:9"],
    image_size: ["square_hd", "square", "landscape_4_3", "portrait_4_3"],
  },
  poster: {
    aspect_ratio: ["4:5", "3:4", "1:1", "9:16", "4:3", "16:9"],
    image_size: ["portrait_4_3", "square_hd", "square", "landscape_4_3"],
  },
  hypermotion: {
    aspect_ratio: ["16:9", "21:9", "4:3", "1:1", "9:16"],
    image_size: ["landscape_16_9", "landscape_4_3", "square_hd", "square"],
  },
  tvspot: {
    aspect_ratio: ["16:9", "21:9", "4:3", "1:1", "9:16"],
    image_size: ["landscape_16_9", "landscape_4_3", "square_hd", "square"],
  },
};

function applyFrameDefault(params, model, format) {
  const preferences = FORMAT_FRAME_PREFERENCES[format];
  if (!preferences || !model?.params) return params;

  const next = { ...params };
  for (const field of ["aspect_ratio", "image_size"]) {
    const spec = model.params[field];
    if (!spec?.enum?.length) continue;
    const preferred = preferences[field]?.find((candidate) =>
      spec.enum.some((value) => String(value) === candidate)
    );
    if (preferred !== undefined) {
      next[field] = spec.enum.find((value) => String(value) === preferred);
    }
  }
  return next;
}

async function readJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    let message = `${response.status} ${response.statusText || "request failed"}`;
    try {
      const payload = JSON.parse(text);
      message = payload.error || payload.detail || message;
    } catch {
      if (text.trim()) message = text.trim();
    }
    throw new Error(message);
  }
  if (!text.trim()) throw new Error("The server returned an empty response");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The server returned an invalid response");
  }
}

function errorDetails(error) {
  const raw = String(error?.message ?? error ?? "");
  const lower = raw.toLowerCase();
  if (lower.includes("exhausted balance") || lower.includes("user is locked") || lower.includes("fal balance is empty")) {
    return {
      title: lower.includes("upload failed") ? "Reference upload paused" : "Generation paused",
      message: lower.includes("upload failed")
        ? "The reference cannot be uploaded while your fal balance is empty. Add funds, then try the upload again."
        : "Your fal balance is empty. Add funds, then return here and try again.",
      action: "Open fal billing",
      href: "https://fal.ai/dashboard/billing",
    };
  }
  if (lower.includes("server is unavailable") || lower.includes("failed to fetch") || lower.includes("cannot reach")) {
    return {
      title: "Studio is offline",
      message: "The local generation server is not responding. Restart it, then retry.",
    };
  }
  if (lower.includes("reference") && (lower.includes("switched") || lower.includes("selected instead"))) {
    return {
      title: lower.includes("removed") ? "Model switched" : "Reference-ready model selected",
      message: raw,
      tone: "info",
    };
  }
  if (lower.includes("cannot use the current attachments")) {
    return {
      title: "Choose a compatible model",
      message: raw,
    };
  }
  return {
    title: "Something stopped this run",
    message: raw.replace(/^error:\s*/i, "") || "Please try again.",
  };
}

function ErrorNotice({ error, onClose }) {
  const details = errorDetails(error);
  return (
    <section className={`error-notice${details.tone === "info" ? " info" : ""}`} role="alert">
      <div>
        <strong>{details.title}</strong>
        <p>{details.message}</p>
      </div>
      <div className="error-actions">
        {details.href && (
          <a href={details.href} target="_blank" rel="noreferrer">{details.action}</a>
        )}
        <button type="button" onClick={onClose} aria-label="Dismiss message">Dismiss</button>
      </div>
    </section>
  );
}

function relativeTime(iso) {
  const elapsed = Date.now() - Date.parse(iso || "");
  if (!Number.isFinite(elapsed) || elapsed < 0) return "pending";
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function CatalogStatus({ catalog, syncing, onSync }) {
  const status = catalog?.catalog_sync;
  const newCount = status?.new_endpoint_count;
  return (
    <details className="catalog-status">
      <summary>
        <span>{status?.synced_at ? `Catalog updated ${relativeTime(status.synced_at)}` : "Checking model catalog"}</span>
      </summary>
      <div className="catalog-status-popover">
        <div className="catalog-status-head">
          <div>
            <strong>Live model discovery</strong>
            <span>Automatic refresh every {status?.refresh_hours ?? 6} hours</span>
          </div>
          <button type="button" onClick={onSync} disabled={syncing}>{syncing ? "Syncing…" : "Sync now"}</button>
        </div>
        <dl>
          <div><dt>Production ready</dt><dd>{catalog?.models?.length ?? 0}</dd></div>
          <div><dt>Relevant on fal</dt><dd>{status?.relevant_active_endpoints ?? "—"}</dd></div>
          <div><dt>Awaiting validation</dt><dd>{newCount ?? "—"}</dd></div>
        </dl>
        <p>{status?.policy ?? "The production roster stays stable while fal is checked for new image and video endpoints."}</p>
        {status?.newest?.length > 0 && (
          <div className="catalog-newest">
            <span>Newest detected</span>
            {status.newest.slice(0, 4).map((item) => (
              <a key={item.id} href={item.model_url} target="_blank" rel="noreferrer">
                <b>{item.label}</b><small>{item.category_label}</small>
              </a>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function CreditPanel({ billing, locked, refreshing, onRefresh, onClose }) {
  const balance = billing?.available && billing.current_balance != null
    ? new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: billing.currency || "USD",
        maximumFractionDigits: 2,
      }).format(billing.current_balance)
    : null;
  return (
    <aside className="credit-sheet" aria-label="fal credits">
      <div className="credit-sheet-head">
        <div>
          <h3>fal credits</h3>
          <span>Generation balance for this studio</span>
        </div>
        <button type="button" className="ghost-btn" onClick={onClose}>Close</button>
      </div>
      <div className="credit-sheet-body">
        <section className={`balance-card${locked ? " locked" : ""}`}>
          <span>{locked ? "Generation paused" : balance ? "Available balance" : "Balance"}</span>
          <strong>{locked ? "Credits required" : balance ?? "Not available to this key"}</strong>
          <p>{locked
            ? "fal reported that this account is out of credits. Adding credits will unlock generation and reference uploads."
            : billing?.reason ?? "Balance data refreshes directly from fal."}</p>
        </section>
        <a className="topup-button" href={billing?.top_up_url ?? "https://fal.ai/dashboard/billing"} target="_blank" rel="noreferrer">
          Continue to secure top-up <span aria-hidden="true">↗</span>
        </a>
        <button type="button" className="refresh-balance" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Checking fal…" : "I’ve added credits — refresh balance"}
        </button>
        <p className="credit-security">Payment and card details stay on fal. Bench never receives or stores them.</p>
      </div>
    </aside>
  );
}

export default function App() {
  const [activeView, setActiveView] = useState(() => viewFromHash());
  const [catalog, setCatalog] = useState(null);
  const [modelId, setModelId] = useState(null);
  const [format, setFormat] = useState("none");
  const [shotSettings, setShotSettings] = useState({});
  const [idea, setIdea] = useState("");
  const [rewritten, setRewritten] = useState(null);
  const [params, setParams] = useState({});
  const [refs, setRefs] = useState([]);
  const refsRef = useRef([]);
  const [quote, setQuote] = useState(null);
  const [job, setJob] = useState(null);
  const [shots, setShots] = useState([]);
  const [ledger, setLedger] = useState({ rows: [], summary: null });
  const [showLedger, setShowLedger] = useState(false);
  const [showCredits, setShowCredits] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [billing, setBilling] = useState(null);
  const [refreshingBilling, setRefreshingBilling] = useState(false);
  const [falLocked, setFalLocked] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [syncingCatalog, setSyncingCatalog] = useState(false);
  const [settings, setSettings] = useState(null);
  const [health, setHealth] = useState(null);
  // null = ainda nao perguntamos. Sem senha configurada, `locked` nunca fica
  // true e esta tela inteira e invisivel.
  const [locked, setLocked] = useState(null);

  // Primeira pergunta do app, antes de qualquer dado: preciso de senha? A
  // resposta de /api/auth e publica de proposito — dizer "aqui pede senha" nao
  // entrega nada, e sem isso a interface nao sabe o que desenhar.
  const checkAuth = React.useCallback(async () => {
    try {
      const res = await fetch("/api/auth");
      const body = await res.json();
      setLocked(body.required && !body.authenticated);
    } catch { setLocked(false); }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  useEffect(() => {
    const syncView = () => {
      setActiveView(viewFromHash());
      document.querySelector(".scroll")?.scrollTo({ top: 0 });
    };
    syncView();
    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);

  function openView(view) {
    window.location.hash = view;
    setActiveView(view);
  }
  const abortRef = useRef(null);
  const ledgerRetryRef = useRef(null);

  const model = useMemo(
    () => catalog?.models.find((m) => m.id === modelId) ?? null,
    [catalog, modelId]
  );
  const referenceModel = useMemo(
    () => pairedImageModel(catalog?.models, model),
    [catalog, model]
  );

  useEffect(() => {
    refsRef.current = refs;
  }, [refs]);

  useEffect(() => {
    let dead = false;
    let retryTimer;

    async function loadCatalog(attempt = 0) {
      try {
        const c = await readJson("/api/models");
        if (!c.models?.length) throw new Error("The model catalog is empty");
        if (dead) return;
        setCatalog(c);
        setModelId((current) => {
          if (current) return current;
          let pinned = "";
          let last = "";
          try {
            pinned = localStorage.getItem("bench.model-filter-pinned") || "";
            last = localStorage.getItem("bench.last-model") || "";
          } catch {}
          const previous = c.models.find((candidate) => candidate.id === last && (!pinned || candidate.kind === pinned));
          const usaveis = c.models.filter((candidate) => candidate.enabled !== false && candidate.available !== false);
          return previous?.id ?? sortModels(usaveis.filter((candidate) => !pinned || candidate.kind === pinned))[0]?.id ?? usaveis[0]?.id ?? c.models[0]?.id ?? null;
        });
        setError(null);
      } catch (e) {
        if (dead) return;
        if (attempt < 12) {
          retryTimer = setTimeout(() => loadCatalog(attempt + 1), Math.min(1800, 450 + attempt * 125));
        } else {
          setError("The studio server is unavailable. Start the app again and retry.");
        }
      }
    }

    loadCatalog();
    readJson("/api/settings").then(setSettings).catch(() => {});
    readJson("/api/health").then(setHealth).catch(() => {});
    refreshLedger();
    refreshBilling();
    // Criar um modo na aba Modes muda o catalogo, mas trocar de aba e so uma
    // mudanca de hash — nao recarrega a pagina. Sem este aviso, o modo recem
    // criado so aparecia na barra depois de um refresh manual.
    const onModesChanged = () => loadCatalog();
    window.addEventListener("bench:modes-changed", onModesChanged);
    return () => {
      dead = true;
      window.removeEventListener("bench:modes-changed", onModesChanged);
      clearTimeout(retryTimer);
      clearTimeout(ledgerRetryRef.current);
    };
  }, []);

  async function refreshBilling(force = false) {
    setRefreshingBilling(true);
    try {
      const value = await readJson(`/api/fal/billing${force ? "?refresh=1" : ""}`);
      setBilling(value);
      if (value.available && Number(value.current_balance) > 0) setFalLocked(false);
    } catch {
      // Billing visibility must never block the creation UI.
    } finally {
      setRefreshingBilling(false);
    }
  }

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && showCredits) refreshBilling(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [showCredits]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setInterval(() => {
      readJson("/api/catalog/status")
        .then((status) => setCatalog((current) => current ? { ...current, catalog_sync: status } : current))
        .catch(() => {});
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  async function syncCatalog() {
    setSyncingCatalog(true);
    try {
      const status = await readJson("/api/catalog/sync", { method: "POST" });
      setCatalog((current) => current ? { ...current, catalog_sync: status } : current);
    } catch (error) {
      setError(`Catalog sync failed: ${error.message ?? error}`);
    } finally {
      setSyncingCatalog(false);
    }
  }

  function refreshLedger(attempt = 0) {
    readJson("/api/ledger")
      .then((l) => {
        setLedger(l);
        const past = (l.rows ?? [])
          .filter((r) => r.outputs?.length)
          .map((r) => ({ ...r, at: new Date(r.ts).getTime() }));
        setShots(past);
      })
      .catch(() => {
        if (attempt < 12) {
          ledgerRetryRef.current = setTimeout(() => refreshLedger(attempt + 1), Math.min(1800, 450 + attempt * 125));
        }
      });
  }

  async function deleteResult(shot) {
    if (!shot?.archive_id) throw new Error("This result is not in the local archive.");
    try {
      const result = await readJson(`/api/results/${encodeURIComponent(shot.archive_id)}`, { method: "DELETE" });
      setShots((current) => current.filter((candidate) => candidate.archive_id !== shot.archive_id));
      setLedger((current) => ({
        ...current,
        rows: (current.rows ?? []).filter((candidate) => candidate.archive_id !== shot.archive_id),
        summary: result.summary,
      }));
    } catch (deleteError) {
      setError(`Could not delete this result: ${deleteError.message ?? deleteError}`);
      throw deleteError;
    }
  }

  useEffect(() => {
    if (!model) return;
    const next = {};
    for (const [name, spec] of Object.entries(model.params)) {
      if (HIDE.has(name)) continue;
      if (spec.default !== undefined) next[name] = spec.default;
      else if (spec.enum?.length) next[name] = spec.enum[0];
    }
    setParams(next);
    setRewritten(null);
  }, [modelId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const next = Object.fromEntries((SHOT_DIRECTION[format] ?? []).map((field) => [field.id, field.options[0].value]));
    setShotSettings(next);
    setRewritten(null);
  }, [format]);

  useEffect(() => {
    if (!model) return;
    setParams((current) => applyFrameDefault(current, model, format));
  }, [format, modelId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!modelId) return;
    let dead = false;
    readJson("/api/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId, params }),
    })
      .then((q) => { if (!dead) setQuote(q); })
      .catch(() => {});
    return () => { dead = true; };
  }, [modelId, params]);

  async function optimize() {
    if (!idea.trim() || !modelId) return;
    const assignment = assignInputFields(model, refs);
    if (!assignment.ok) return setError(assignment.reason);
    setBusy(true); setError(null);
    try {
      const result = await readJson("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea, modelId, format, params, shotSettings, refCount: refs.length, hasReference: refs.length > 0 }),
      });
      setRewritten(result);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  async function attach(file) {
    setBusy(true); setError(null);
    try {
      const mediaType = mediaTypeForFile(file);
      if (mediaType === "file") throw new Error("Use an image, video, audio file, or PDF.");
      let targetModel = model;
      if (!mediaInputsFor(targetModel, mediaType).length && mediaType === "image" && referenceModel) {
        targetModel = referenceModel;
      }
      if (!mediaInputsFor(targetModel, mediaType).length) {
        throw new Error(`${model?.label ?? "This model"} does not accept ${mediaType} input. Choose a compatible model first.`);
      }
      const fd = new FormData();
      fd.append("file", file);
      const j = await readJson("/api/upload", { method: "POST", body: fd });
      if (j.error) throw new Error(j.error);
      const nextAsset = {
        ...j,
        url: j.remote_url ?? j.url,
        name: file.name,
        media_type: j.media_type ?? mediaType,
        preview: URL.createObjectURL(file),
      };
      // Multiple files are uploaded sequentially from one chooser event. React
      // has not necessarily rendered the previous attachment before the next
      // upload resolves, so read and update the synchronous ref as the source
      // of truth for this burst.
      const assignment = assignInputFields(targetModel, [...refsRef.current, nextAsset]);
      if (!assignment.ok) throw new Error(assignment.reason);
      refsRef.current = assignment.assets;
      setRefs(assignment.assets);
      if (targetModel?.id !== model?.id) {
        setModelId(targetModel.id);
        setRewritten(null);
      }
    } catch (e) {
      const message = `Upload failed: ${e.message ?? e}`;
      if (/exhausted balance|user is locked/i.test(message)) setFalLocked(true);
      setError(message);
    }
    finally { setBusy(false); }
  }

  async function generate() {
    const prompt = (rewritten?.prompt ?? idea).trim();
    if (!prompt || !modelId) return;

    const assignment = assignInputFields(model, refs);
    if (!assignment.ok) return setError(assignment.reason);

    setBusy(true); setError(null);
    setJob({ phase: "submitting", model: model?.label });

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          modelId, prompt, params, format, rawIdea: idea,
          shotSettings,
          inputAssets: refs.map(({ url, field, media_type, upload_id, name }) => ({ url, field, media_type, upload_id, name })),
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        let message = `Generation failed (${res.status})`;
        try { message = JSON.parse(text).error || message; } catch {}
        throw new Error(message);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      // A resposta e um fluxo NDJSON que TERMINA num evento `done` ou `error`.
      // Se a conexao cair no meio — servidor reiniciado, rede oscilando, aba
      // suspensa — o laco simplesmente acabava e nada era dito: sem resultado,
      // sem erro, sem explicacao. Foi exatamente o que aconteceu numa geracao de
      // video real. Silencio e o pior desfecho possivel: a pessoa nao sabe se
      // espera, se tenta de novo, ou se ja pagou por aquilo.
      let terminou = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.phase === "error") {
            terminou = true;
            if (/exhausted balance|user is locked/i.test(ev.error ?? "")) setFalLocked(true);
            setError(ev.error); setJob(null);
          }
          else if (ev.phase === "done") {
            terminou = true;
            setShots((p) => [{ ...ev.ledger, at: Date.now() }, ...p]);
            setJob(null);
            setLedger((l) => ({ ...l, summary: ev.spend }));
            refreshLedger();
          } else setJob((j) => ({ ...j, ...ev }));
        }
      }
      if (!terminou) {
        setJob(null);
        setError(
          "A conexao com o estudio caiu antes de a geracao terminar. " +
          "O trabalho pode ter continuado do lado do provedor — confira em Results antes de gerar de novo, " +
          "para nao pagar duas vezes pela mesma coisa.",
        );
        // O provedor pode ter concluido depois da queda; o ledger e a fonte da
        // verdade, entao vale reler em vez de assumir que nao saiu nada.
        refreshLedger();
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        const message = String(e.message ?? e);
        if (/exhausted balance|user is locked/i.test(message)) setFalLocked(true);
        setError(message);
      }
      setJob(null);
    } finally { setBusy(false); abortRef.current = null; }
  }

  // "Redo": recarrega no Create a configuracao EXATA de um resultado do arquivo.
  // Tudo que isso precisa ja estava sendo gravado no ledger desde sempre
  // (modelo, params, prompt, a ideia crua e os anexos) — so nao havia como
  // trazer de volta. Sem isso, repetir uma geracao boa era redigitar de memoria.
  function reuseShot(shot) {
    if (!shot) return;
    const picked = catalog?.models.find((m) => m.id === shot.model);
    if (!picked) {
      setError(`O modelo ${shot.model} nao esta mais no catalogo, entao esta configuracao nao pode ser recarregada.`);
      return;
    }
    // O prompt vive dentro de params porque params E o payload enviado ao
    // provider; como controle, ele nao entra.
    const { prompt: _sent, ...controls } = shot.params ?? {};
    setModelId(shot.model);
    setFormat(shot.format ?? "none");
    setParams(controls);
    // A ideia original (em portugues, antes do refino) e o que a pessoa quer
    // editar; o prompt refinado vai junto como rascunho pronto, para dar Redo
    // sem pagar outra reescrita.
    setIdea(shot.raw_idea || shot.prompt || "");
    setRewritten(shot.prompt ? { prompt: shot.prompt, optimized: true, restored: true } : null);
    // `preview` é o que a barra usa para desenhar a miniatura, e no upload ele é
    // um object URL criado a partir do File — memória do navegador, que nunca foi
    // persistida e não existe mais numa sessão futura. Sem reconstruí-lo a partir
    // das URLs que ficaram gravadas, a referência restaurada aparece como imagem
    // quebrada mesmo estando íntegra no arquivo.
    const assets = (shot.input_assets ?? []).map((asset) => {
      const source = asset.local_url || asset.url;
      return {
        ...asset,
        url: source,
        preview: asset.preview || source,
        name: asset.name || "reference",
        media_type: asset.media_type || "image",
      };
    });
    setRefs(assets);
    refsRef.current = assets;
    setQuote(null);
    setError(null);
    // Quem rola nesta aplicação é o contêiner `.scroll`, não a janela — o
    // window.scrollTo daqui não movia nada. E o salto precisa acontecer DEPOIS
    // do React trocar de aba, senão rola a tela antiga.
    window.location.hash = "create";
    requestAnimationFrame(() => {
      // Instantâneo, não suave: com o arquivo cheio a lista passa de 4000px e a
      // animação leva segundos, durante os quais a tela parece não ter reagido
      // ao clique. Além disso as imagens abaixo terminam de carregar no meio do
      // caminho e empurram o layout, competindo com a animação.
      const scroller = document.querySelector(".scroll");
      (scroller ?? window).scrollTo({ top: 0 });
      // O cursor já no campo de texto: quem clicou em Redo quer editar a ideia
      // ou gerar de novo, e nos dois casos o próximo gesto é ali.
      document.getElementById("prompt-idea")?.focus({ preventScroll: true });
    });
  }

  // Curadoria do catalogo: preferencia, nao disponibilidade. Depois de gravar,
  // o catalogo e relido para a tela refletir a verdade do servidor, e nao um
  // palpite otimista do cliente.
  // Aceita um id ou uma lista: o mesmo gesto serve para um card e para "ligar
  // os 12 filtrados", sem duplicar caminho.
  async function toggleModel(id, enabled) {
    try {
      await readJson("/api/catalog/enabled", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.isArray(id) ? id : [id], enabled }),
      });
      const fresh = await readJson("/api/models");
      setCatalog(fresh);
    } catch (e) { setError(String(e.message ?? e)); }
  }

  async function refreshCatalog() {
    setSyncingCatalog(true);
    try {
      const r = await readJson("/api/catalog/refresh", { method: "POST" });
      setCatalog(await readJson("/api/models"));
      // Relatorio honesto: as tres partes podem falhar em separado, e dizer
      // "atualizado" quando o preco nao veio seria mentira confortavel.
      const partes = [
        r.discovery?.ok ? `${r.discovery.relevant} endpoints vistos` : `descoberta falhou (${r.discovery?.error ?? "?"})`,
        r.pricing?.ok ? `precos ${r.pricing.priced}/${r.pricing.of}` : `precos falharam (${r.pricing?.error ?? "?"})`,
      ];
      setError(`Catalogo atualizado — ${partes.join(" · ")}`);
    } catch (e) { setError(String(e.message ?? e)); }
    finally { setSyncingCatalog(false); }
  }

  async function saveSettings(patch) {
    try { setSettings(await readJson("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) })); }
    catch (e) { setError(String(e.message ?? e)); }
  }

  async function bulkCatalog(payload) {
    try {
      await readJson("/api/catalog/enabled", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const fresh = await readJson("/api/models");
      setCatalog(fresh);
    } catch (e) { setError(String(e.message ?? e)); }
  }

  function pickModel(nextId) {
    const picked = catalog?.models.find((candidate) => candidate.id === nextId);
    if (!picked) return;
    let switchNotice = null;
    if (refs.length && picked) {
      const retained = retainCompatibleAssets(picked, refs);
      setRefs(retained.assets);
      refsRef.current = retained.assets;
      if (retained.removed.length) {
        const count = retained.removed.length;
        switchNotice = `Switched to ${picked.label}. Removed ${count} incompatible reference${count === 1 ? "" : "s"} because this model cannot accept ${count === 1 ? "it" : "them"}.`;
      }
    }
    setModelId(nextId);
    setRewritten(null);
    setQuote(null);
    try { localStorage.setItem("bench.last-model", nextId); } catch {}
    setError(switchNotice);
  }

  if (locked === null) return null;
  if (locked) return <Login onDone={() => { setLocked(false); window.location.reload(); }} />;

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">Skip to workspace</a>
      <TopBar
        summary={ledger.summary}
        activeView={activeView}
        version={health?.version}
        onConfig={() => { setShowCredits(false); setShowLedger(false); setShowConfig((v) => !v); }}
        configOpen={showConfig}
        onLedger={() => { setShowCredits(false); setShowConfig(false); setShowLedger((v) => !v); }}
        ledgerOpen={showLedger}
        billing={billing}
        onCredits={() => { setShowLedger(false); setShowConfig(false); setShowCredits((value) => !value); }}
        creditsOpen={showCredits}
      />

      <div className="scroll">
        <div className="studio-layout">
          <main className="workspace" id="main-content" tabIndex="-1">
            <div className="workspace-inner">
              {activeView === "create" && <section className="hero view-page" id="create">
                <div className="workspace-head">
                  <div className="hero-copy">
                    <div className="eyebrow">Create</div>
                    <h1>Create a <em>shot</em>.</h1>
                    <p>Choose a model, add a reference if you have one, and describe the result.</p>
                  </div>
                </div>

                <div className="creator">
                  <div className="creator-head">
                    <h2>Describe your shot</h2>
                    {catalog ? (
                      <CatalogStatus catalog={catalog} syncing={syncingCatalog} onSync={syncCatalog} />
                    ) : <span>Loading models</span>}
                  </div>
                  <PromptBar
                    catalog={catalog}
                    model={model}
                    idea={idea}
                    setIdea={(v) => { setIdea(v); setRewritten(null); }}
                    format={format}
                    setFormat={(v) => { setFormat(v); setRewritten(null); }}
                    params={params}
                    setParams={setParams}
                    hide={HIDE}
                    refs={refs}
                    onAttach={attach}
                    onRemoveRef={(i) => setRefs((current) => {
                      const next = current.filter((_, j) => j !== i);
                      refsRef.current = next;
                      return next;
                    })}
                    rewritten={rewritten}
                    setRewritten={setRewritten}
                    onOptimize={optimize}
                    onGenerate={generate}
                    onPickModel={pickModel}
                    referenceModel={referenceModel}
                    shotSettings={shotSettings}
                    setShotSettings={(next) => { setShotSettings(next); setRewritten(null); }}
                    quote={quote}
                    busy={busy}
                    running={Boolean(job)}
                  />
                </div>

                {error && <ErrorNotice error={error} onClose={() => setError(null)} />}
                {!error && !shots.length && !job && (
                  <div className="hint"><span><b>Add a reference</b> if it helps. Then describe the shot in your own words.</span></div>
                )}
                {(job || shots.length > 0) && (
                  <section className="create-results" id="create-results" aria-label="Generated media">
                    <Work job={job} shots={shots} onDelete={deleteResult} onReuse={reuseShot} />
                  </section>
                )}
              </section>}

              {activeView === "work" && (
                <section className="view-page" id="work">
                  <div className="view-heading">
                    <div>
                      <div className="eyebrow">Results</div>
                      <h1>Everything you made.</h1>
                      <p>Images and videos, with the model, prompt, local copy, and actual billed cost attached.</p>
                    </div>
                    <a className="view-action" href="#create">Create another</a>
                  </div>
                  {error && <ErrorNotice error={error} onClose={() => setError(null)} />}
                  <ErrorBoundary name="Results"><Work job={job} shots={shots} standalone onDelete={deleteResult} onReuse={reuseShot} /></ErrorBoundary>
                </section>
              )}

              {activeView === "models" && (
                <section className="view-page" id="models">
                  <div className="view-heading">
                    <div>
                      <div className="eyebrow">Model catalog</div>
                      <h1>Pick the right model.</h1>
                      <p>Compare output type, accepted inputs, speed, and pricing before you commit to a run.</p>
                    </div>
                  </div>
                  <ErrorBoundary name="Model catalog"><ModelWall
                    catalog={catalog}
                    modelId={modelId}
                    onToggle={toggleModel}
                    onBulk={bulkCatalog}
                    onRefresh={refreshCatalog}
                    settings={settings}
                    onSettings={saveSettings}
                    onPick={(nextId) => {
                      pickModel(nextId);
                      openView("create");
                    }}
                  /></ErrorBoundary>
                </section>
              )}
              {activeView === "modes" && <ErrorBoundary name="Modes"><Modes /></ErrorBoundary>}
              {activeView === "connect" && <ErrorBoundary name="Connect"><Tooling /></ErrorBoundary>}
              {activeView === "websites" && <ErrorBoundary name="Websites"><CreativeStudio kind="website" /></ErrorBoundary>}
              {activeView === "documents" && <ErrorBoundary name="Documents"><CreativeStudio kind="document" /></ErrorBoundary>}
            </div>
          </main>
        </div>
      </div>

      {showConfig && (
        <>
          <div className="modal-scrim" onClick={() => setShowConfig(false)} />
          <ErrorBoundary name="Configuration">
            <Config onClose={() => setShowConfig(false)} />
          </ErrorBoundary>
        </>
      )}
      {showLedger && (
        <>
          <div className="modal-scrim" onClick={() => setShowLedger(false)} />
          <Ledger ledger={ledger} onClose={() => setShowLedger(false)} />
        </>
      )}
      {showCredits && (
        <>
          <div className="modal-scrim" onClick={() => setShowCredits(false)} />
          <CreditPanel
            billing={billing}
            locked={falLocked}
            refreshing={refreshingBilling}
            onRefresh={() => refreshBilling(true)}
            onClose={() => setShowCredits(false)}
          />
        </>
      )}
    </div>
  );
}
