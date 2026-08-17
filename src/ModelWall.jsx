import React, { useMemo, useState } from "react";
import { sortModels } from "./modelCatalog.js";

// The roster, as pictures. Every tile is a real sample frame published by the
// model itself, and the price is on the tile because that is the whole point.

const GROUPS = [
  { lane: "t2i", head: "Image models", note: "Start with a description" },
  { lane: "i2i", head: "Image edits", note: "Change a reference" },
  { lane: "t2v", head: "Video models", note: "Start with a description" },
  { lane: "i2v", head: "Image to video", note: "Animate an image" },
  { lane: "r2v", head: "Reference video", note: "Keep a look consistent" },
];

export default function ModelWall({ catalog, modelId, onPick, onToggle, onBulk, onRefresh, settings, onSettings }) {
  const [showUnavailable, setShowUnavailable] = useState(false);

  const [provider, setProvider] = useState("all");
  const [output, setOutput] = useState("all");
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");

  // As opcoes saem do proprio catalogo, com contagem — provedor que voce nao tem
  // nao ocupa espaco na barra.
  // Por provedor: quantos existem, quantos estao ligados e se a rota esta
  // utilizavel. E a unidade natural de decisao — quase toda escolha aqui e
  // "quero ou nao quero este provedor", nao modelo a modelo.
  const providerOptions = useMemo(() => {
    const acc = new Map();
    for (const m of catalog?.models ?? []) {
      const cur = acc.get(m.provider) ?? { id: m.provider, label: m.provider_label ?? m.provider, total: 0, on: 0, ids: [], available: m.available !== false };
      cur.total += 1;
      cur.ids.push(m.id);
      if (m.enabled !== false) cur.on += 1;
      if (m.available === false) cur.available = false;
      acc.set(m.provider, cur);
    }
    return [...acc.values()].sort((a, b) => b.total - a.total);
  }, [catalog]);

  const stats = useMemo(() => {
    const models = catalog?.models ?? [];
    return {
      total: models.length,
      unavailable: models.filter((m) => m.available === false).length,
      off: models.filter((m) => m.available !== false && m.enabled === false).length,
    };
  }, [catalog]);

  if (!catalog) return null;

  // "Gratuito" aqui e fato apurado, nao rotulo: provedor local ou provedor cujo
  // preco medido e zero. Serve para o atalho de ligar so o que nao cobra.
  // O recorte vale para TODOS os grupos, e e o mesmo conjunto que os atalhos de
  // curadoria enxergam — senao "so os gratuitos" ignoraria o filtro na tela e a
  // pessoa veria um resultado diferente do que pediu.
  const matches = (m) =>
    (provider === "all" || m.provider === provider)
    && (output === "all" || m.kind === output)
    && (status === "all"
      || (status === "on" && m.enabled !== false && m.available !== false)
      || (status === "off" && m.enabled === false)
      || (status === "unavailable" && m.available === false))
    && (!query.trim() || `${m.label} ${m.vendor} ${m.id}`.toLowerCase().includes(query.trim().toLowerCase()));

  const visiveis = (catalog.models ?? []).filter(matches);
  const filtrando = provider !== "all" || output !== "all" || status !== "all" || query.trim();

  // Custo vem da classe que o servidor deriva do adapter (cost_class), nao de
  // uma lista de nomes de provedor aqui: quem cobra hoje pode nao cobrar amanha.
  const idsComClasse = (classe) => (catalog.models ?? []).filter((m) => m.cost_class === classe).map((m) => m.id);
  const freeIds = idsComClasse("free");
  const creditIds = idsComClasse("credits");
  const localIds = (catalog.models ?? []).filter((m) => m.provider === "inemaimg").map((m) => m.id);

  // Cada grupo é um INTERRUPTOR, não um "só isto": clicar em Free liga os
  // gratuitos sem desligar o resto, e clicar de novo desliga só eles. O "só
  // isto" de antes escondia uma segunda ação (desligar tudo mais) atrás de um
  // rótulo que não a anunciava.
  const enabledIds = new Set((catalog.models ?? []).filter((m) => m.enabled !== false).map((m) => m.id));
  const allOn = (ids) => ids.length > 0 && ids.every((id) => enabledIds.has(id));

  return (
    <div className="wall model-wall">
      <div className="catalog-filters" role="group" aria-label="Filter catalog">
        <div className="provider-chips" role="group" aria-label="Providers">
          <span className="results-filter-label">Provider</span>
          <button
            type="button"
            className={`provider-chip${provider === "all" ? " selected" : ""}`}
            onClick={() => setProvider("all")}
          >
            All <small>{stats.total}</small>
          </button>
          {providerOptions.map((p) => (
            <span className={`provider-chip-wrap${provider === p.id ? " selected" : ""}${p.available ? "" : " unavailable"}`} key={p.id}>
              <button
                type="button"
                className="provider-chip"
                onClick={() => setProvider(provider === p.id ? "all" : p.id)}
                title={p.available ? `Show only ${p.label}` : `${p.label} is unavailable`}
              >
                {p.id} <small>{p.on}/{p.total}</small>
              </button>
              {onToggle && (
                // Liga ou desliga o provedor INTEIRO. Meio caminho (alguns
                // ligados) conta como desligado para o clique: o gesto esperado
                // e "quero este provedor", e ai o certo e ligar o que falta.
                <button
                  type="button"
                  className={`provider-switch${p.on === p.total ? " on" : ""}`}
                  role="switch"
                  aria-checked={p.on === p.total}
                  aria-label={`${p.on === p.total ? "Disable" : "Enable"} all ${p.label} models`}
                  title={p.on === p.total ? `Turn off all ${p.total}` : `Turn on all ${p.total}`}
                  onClick={() => onToggle(p.ids, p.on !== p.total)}
                >
                  {p.on === p.total ? "on" : p.on === 0 ? "off" : `${p.on}`}
                </button>
              )}
            </span>
          ))}
        </div>
        <label className="results-filter">
          <span>Output</span>
          <select value={output} onChange={(e) => setOutput(e.target.value)}>
            <option value="all">All</option>
            <option value="image">Image</option>
            <option value="video">Video</option>
          </select>
        </label>
        <label className="results-filter">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All</option>
            <option value="on">Enabled</option>
            <option value="off">Disabled ({stats.off})</option>
            <option value="unavailable">Unavailable ({stats.unavailable})</option>
          </select>
        </label>
        <label className="results-filter wide">
          <span>Search</span>
          <input value={query} placeholder="name, vendor or id" onChange={(e) => setQuery(e.target.value)} />
        </label>
        {filtrando && (
          <button type="button" className="results-filter-clear" onClick={() => { setProvider("all"); setOutput("all"); setStatus("all"); setQuery(""); }}>
            Clear
          </button>
        )}
      </div>

      <div className="catalog-toolbar">
        <div>
          <strong>{filtrando ? `${visiveis.length} of ${stats.total}` : stats.total} models</strong>
          {stats.unavailable > 0 && <span>{stats.unavailable} unavailable</span>}
          {stats.off > 0 && <span>{stats.off} turned off by you</span>}
        </div>
        <div className="catalog-toolbar-actions">
          {stats.unavailable > 0 && (
            <label className="catalog-switch-inline">
              <input type="checkbox" checked={showUnavailable} onChange={(e) => setShowUnavailable(e.target.checked)} />
              Show unavailable
            </label>
          )}
          {onRefresh && (
            <button type="button" onClick={() => onRefresh()} title="Discovers new models, pulls live prices, and rechecks keys">
              Refresh catalog
            </button>
          )}
          {onSettings && (
            <label className="catalog-switch-inline" title="How often the catalog refreshes on its own">
              auto
              <select
                value={String(settings?.catalog_refresh_hours ?? 6)}
                onChange={(e) => onSettings({ catalog_refresh_hours: Number(e.target.value) })}
              >
                <option value="0">manual only</option>
                <option value="1">1h</option>
                <option value="6">6h</option>
                <option value="24">24h</option>
                <option value="168">weekly</option>
              </select>
            </label>
          )}
          {onBulk && (
            <>
              {filtrando && onToggle && (
                <>
                  <button type="button" onClick={() => onToggle(visiveis.map((m) => m.id), true)}>Enable the {visiveis.length} filtered</button>
                  <button type="button" onClick={() => onToggle(visiveis.map((m) => m.id), false)}>Disable those {visiveis.length}</button>
                </>
              )}
              <button
                type="button"
                className={allOn(freeIds) ? "on" : ""}
                onClick={() => onToggle(freeIds, !allOn(freeIds))}
                title={`${freeIds.length} models that cost nothing on your current plan — this reflects today's billing, not a permanent property`}
              >
                No cost
              </button>
              {creditIds.length > 0 && (
                <button
                  type="button"
                  className={allOn(creditIds) ? "on" : ""}
                  onClick={() => onToggle(creditIds, !allOn(creditIds))}
                  title={`${creditIds.length} models billed as credits from a plan you already pay`}
                >
                  Plan credits
                </button>
              )}
              <button
                type="button"
                className={allOn(localIds) ? "on" : ""}
                onClick={() => onToggle(localIds, !allOn(localIds))}
                title={`${localIds.length} models running on your own machine`}
              >
                Local
              </button>
              <button type="button" onClick={() => onBulk({ only: [] })}>Clear all</button>
              <button type="button" onClick={() => onBulk({ reset: true })}>Enable all</button>
            </>
          )}
        </div>
      </div>
      {GROUPS.map((g) => {
        const models = sortModels(visiveis.filter((m) => m.lane === g.lane))
          // Modelo desligado continua visivel: e assim que da para liga-lo de
          // volta. O que ele perde e o destaque, nao a existencia. Indisponivel
          // so aparece se voce pedir, e nunca some sem dizer por que.
          .filter((m) => m.available !== false || showUnavailable);
        if (!models.length) return null;
        return (
          <section key={g.lane}>
            <div className="wall-head">
              <h2>{g.head}</h2>
              <span>{g.note}</span>
              <div className="rule" />
              <span>{models.length} {models.length === 1 ? "model" : "models"}</span>
            </div>
            <div className="grid">
              {models.map((m) => (
                <div className="card-wrap" key={m.id}>
                {onToggle && (
                  // Controle proprio, fora do botao do card: clicar aqui liga ou
                  // desliga e NUNCA navega. Antes isso vivia dentro do card e so
                  // aparecia num "modo curadoria" — quem clicava num card
                  // querendo liga-lo era levado para a tela de criacao.
                  <button
                    type="button"
                    className={`card-switch${m.enabled === false ? "" : " on"}`}
                    role="switch"
                    aria-checked={m.enabled !== false}
                    aria-label={`${m.enabled === false ? "Enable" : "Disable"} ${m.label}`}
                    title={m.enabled === false ? "Turn on: show in Create and MCP" : "Turn off: hide from Create and MCP"}
                    onClick={(event) => { event.stopPropagation(); onToggle(m.id, m.enabled === false); }}
                  >
                    {m.enabled === false ? "off" : "on"}
                  </button>
                )}
                <button
                  className={`card${m.id === modelId ? " on" : ""}${m.available === false ? " unavailable" : ""}${m.enabled === false ? " off" : ""}`}
                  onClick={() => onPick(m.id)}
                  disabled={m.available === false}
                  title={m.available === false ? `${m.unavailable_reason}. ${m.unavailable_hint ?? ""}` : m.id}
                >
                  {m.thumbnail ? (
                    <img className="shot" src={m.thumbnail} alt="" loading="lazy" />
                  ) : (
                    <div className="shot" />
                  )}
                  <div className="body">
                    <div className="t">
                      <span
                        className={`pip${m.has_profile ? "" : " hollow"}`}
                        title={m.has_profile ? "Prompt profile ready" : "Prompt profile not available"}
                      />
                      {m.label}
                    </div>
                    <div className="s">
                      <span>{m.vendor}</span>
                      <b>{price(m) || COST_LABEL[m.cost_class] || ""}</b>
                    </div>
                    <div className="card-capabilities">
                      <span>{m.kind === "video" ? "Video output" : "Image output"}</span>
                      <span>{m.capabilities?.modalities?.length
                        ? `Takes ${m.capabilities.modalities.map((item) => item === "document" ? "PDF" : item).join(" + ")}`
                        : "Prompt only"}</span>
                    </div>
                    <span className="card-evidence">{m.capabilities?.inputs?.length ? "Schema checked" : "No media input in schema"}</span>
                    {m.tier === "fastest" && <span className="card-tier">Fast lane</span>}
                    {m.available === false && (
                      <span className="card-unavailable">
                        <b>{m.unavailable_reason}</b>
                        {m.unavailable_hint && <small>{m.unavailable_hint}</small>}
                      </span>
                    )}
                  </div>
                </button>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// fal bills in different units per model, so say which unit rather than
// pretending everything is priced per picture.
// Nem todo provedor cobra em dolar. Sem isto, um modelo do Kling (credito de
// plano) e um da Agnes (zero hoje) apareciam com o preco em branco, como se a
// informacao nao existisse.
const COST_LABEL = {
  free: "no cost",
  credits: "plan credits",
  unknown: "priced after run",
};

const UNIT_LABEL = {
  images: "/img",
  megapixels: "/MP",
  "processed megapixels": "/MP",
  seconds: "/sec",
  "compute seconds": "/compute sec",
  units: "/unit",
};

function price(m) {
  const p = m.pricing;
  if (!p) return "";
  const n = p.price < 0.01 ? p.price.toFixed(5).replace(/0+$/, "") : String(p.price);
  return `$${n}${UNIT_LABEL[p.unit] ?? ""}`;
}
