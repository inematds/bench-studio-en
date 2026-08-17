// server.mjs — the whole "aggregator" in one file.
//
// This is the part Higgsfield charges a subscription for: hold the keys, know
// each model's schema, rewrite the prompt for the model you picked, submit,
// poll, and write down what it cost. None of it is hard. That is the point.
//
//   node server.mjs        (listens on :8787)
//
// Keys come from ~/.env. Nothing is ever sent to the browser.

import express from "express";
import multer from "multer";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, createWriteStream, unlinkSync, rmSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { readCatalogSync, syncFalCatalog } from "./catalog_sync.mjs";
import { createStore } from "./db.mjs";
import { loadOrBuildCapabilityManifest } from "./build_capabilities.mjs";
import { agnesProvider } from "./providers/agnes.mjs";
import { createInemaimgProvider } from "./providers/inemaimg.mjs";
import { kieProvider } from "./providers/kie.mjs";
import { createKlingProvider } from "./providers/kling.mjs";
import { createModesStore } from "./modes_store.mjs";
import { createCatalogPrefs } from "./catalog_prefs.mjs";
import { ENGINES } from "./project_engines.mjs";
import { mergeProviderModels } from "./providers/registry_merge.mjs";
import { describeConfig, validatePatch, writeConfig, isLoopback } from "./config_store.mjs";
import { createAuth, hashPassword } from "./auth.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- env
//
// Isto roda ANTES de qualquer constante derivada de env. Antes vinha depois, e
// por isso BENCH_DATA_DIR num arquivo era ignorado em silêncio: quando o valor
// era lido, DATA já tinha sido resolvido.
//
// Precedência: o que o shell já exportou vence, depois o .env DO PROJETO, e por
// último ~/.env. O .env do projeto é o que a aba Config grava e o que
// `.env.example` sempre documentou — só que ninguém o lia, então copiar o
// exemplo para .env não fazia efeito nenhum.
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnvFile(join(HERE, "..", ".env"));
loadEnvFile(join(homedir(), ".env"));

const DATA = resolve(process.env.BENCH_DATA_DIR || join(HERE, "..", "data"));
const LEDGER = join(DATA, "ledger.jsonl");
const OUTPUTS = join(DATA, "outputs");
const PREVIEWS = join(DATA, "previews");
const INPUTS = join(DATA, "inputs");
const DATABASE = join(DATA, "bench.db");
const PROJECTS = join(DATA, "projects");
const CATALOG_CACHE = join(DATA, "catalog-sync.json");
const CAPABILITY_FILE = join(HERE, "capabilities.json");
const SKILL_PACKAGES = join(HERE, "..", "integrations", "skills");
const MCP_NODE = existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath;

const FAL_KEY = process.env.FAL_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
// Sem FAL_KEY o estúdio SOBE. Antes ele morria aqui, o que contradizia a regra
// que vale para todos os outros provedores — cada um aparece indisponível com o
// motivo, em vez de derrubar o resto. Quem só usa Agnes ou os modelos locais
// nunca conseguiria abrir a interface para descobrir isso, nem chegar à aba
// Config para colocar a chave que faltava.
if (!FAL_KEY) {
  console.warn("[bench] No FAL_KEY: the 37 fal models will show as unavailable. Add one in Config, or get one at fal.ai/dashboard/keys.");
}

mkdirSync(DATA, { recursive: true });
mkdirSync(OUTPUTS, { recursive: true });
mkdirSync(PREVIEWS, { recursive: true });
mkdirSync(INPUTS, { recursive: true });
mkdirSync(PROJECTS, { recursive: true });
const store = createStore({ dbPath: DATABASE, legacyLedgerPath: LEDGER });
const migratedRows = store.migrateLegacyLedger();
if (migratedRows) console.log(`migrated ${migratedRows} legacy ledger rows into SQLite`);

// ---------------------------------------------------------------- registry + profiles + pricing

// Fonte unica da versao: o package.json. Duplicar em constante e como duplicar
// chave — uma hora as duas divergem e ninguem sabe qual vale.
const APP_VERSION = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version;

const registry = JSON.parse(readFileSync(join(HERE, "registry.json"), "utf8"));

// Modelos de providers não-fal entram aqui — antes do byId e antes do manifesto
// de capabilities, senão a validação de referências de /api/generate rejeita
// todos os anexos desses modelos.
mergeProviderModels(registry);

const byId = new Map(registry.models.map((m) => [m.id, m]));
let CATALOG_SYNC = readCatalogSync(CATALOG_CACHE);
let catalogSyncPromise = null;

async function refreshCatalogDiscovery() {
  if (catalogSyncPromise) return catalogSyncPromise;
  // Only the fal roster is compared against fal's live catalog. Agnes/local
  // models are not fal endpoints, so their absence there is not staleness.
  catalogSyncPromise = syncFalCatalog({ key: FAL_KEY, registry: { ...registry, models: falModels() }, cachePath: CATALOG_CACHE })
    .then((result) => {
      CATALOG_SYNC = result;
      store.recordCatalogSync(result);
      console.log(`catalog sync: ${result.relevant_active_endpoints} relevant active endpoints, ${result.new_endpoint_count} outside the production roster`);
      return result;
    })
    .finally(() => { catalogSyncPromise = null; });
  return catalogSyncPromise;
}

// Prompt profiles are merged from every file the research agents wrote, so
// adding a model's research is just dropping a JSON file in profiles/.
function listProfiles() {
  const dir = join(HERE, "profiles");
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

let PROFILES = {};
let PRICING = {};
function reloadKnowledge() {
  PROFILES = {};
  for (const f of listProfiles()) {
    if (!f.endsWith(".json") || f === "pricing.json") continue;
    try {
      Object.assign(PROFILES, JSON.parse(readFileSync(join(HERE, "profiles", f), "utf8")));
    } catch (e) { console.warn(`profile ${f}: ${e.message}`); }
  }
  const pp = join(HERE, "profiles", "pricing.json");
  PRICING = existsSync(pp) ? JSON.parse(readFileSync(pp, "utf8")) : {};
  console.log(`knowledge: ${Object.keys(PROFILES).length} prompt profiles, ${Object.keys(PRICING).filter(k=>k[0]!=="_").length} priced models`);
}
reloadKnowledge();
const CAPABILITIES = loadOrBuildCapabilityManifest({
  registry,
  profiles: PROFILES,
  path: CAPABILITY_FILE,
});
const capabilityById = new Map(CAPABILITIES.models.map((model) => [model.model_id, model]));
const projectProcesses = new Map();
// A referencia de craft era so variavel de ambiente: mudar exigia editar
// arquivo e reiniciar o estudio. Agora ela mora nos ajustes (editaveis pela
// tela) e o ambiente vira o padrao de fabrica — util para quem distribui uma
// imagem ja configurada.
function creativeReferences() {
  const cfg = readSettings();
  return {
    website: cfg.website_reference || process.env.BENCH_WEBSITE_REFERENCE || null,
    document: cfg.document_reference || process.env.BENCH_DOCUMENT_REFERENCE || null,
    website_url: cfg.website_reference_url || process.env.BENCH_WEBSITE_REFERENCE_URL || null,
  };
}

const CREATIVE_REFERENCES_ENV = {
  website: process.env.BENCH_WEBSITE_REFERENCE || null,
  document: process.env.BENCH_DOCUMENT_REFERENCE || null,
};

// O Codex narra o que aconteceu em codex-events.jsonl. Quando a build morre, a
// última fala dele explica a causa muito melhor que o stderr do processo.
function agentFailureReason(outputDir) {
  try {
    const raw = readFileSync(join(outputDir, "codex-events.jsonl"), "utf8");
    const messages = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.item?.type === "agent_message" && event.item.text) messages.push(event.item.text);
        if (event?.type === "turn.failed" && event.error?.message) messages.push(event.error.message);
        if (event?.type === "error" && event.message) messages.push(event.message);
      } catch { /* linha parcial: ignora */ }
    }
    return messages.at(-1) ?? null;
  } catch { return null; }
}

// Num stack trace, a mensagem está na PRIMEIRA linha e o resto são quadros de
// chamada. Pegar a última linha (o que o código fazia) entrega
// "at async file:///.../project_runner.mjs:87:1" — verdadeiro, e inútil.
function stderrReason(stderr) {
  const lines = String(stderr ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // `^[A-Z]\w*(Error|Exception):` exigia um PREFIXO antes de "Error" — casava com
  // TypeError e SyntaxError e falhava justamente no `Error:` puro, que e o que
  // um `throw new Error(...)` produz. Resultado: a mensagem escrita a mao era
  // ignorada e subia um quadro do stack no lugar dela.
  const named = lines.find((line) => /^\w*(Error|Exception):/.test(line));
  if (named) return named;
  // Antes de imprimir o erro, o Node imprime o ARQUIVO e a linha do throw, mais
  // o trecho de codigo e um circunflexo. Nada disso e motivo de falha.
  const useful = lines.filter((line) =>
    !/^at\s/.test(line)
    && !/^Node\.js v/.test(line)
    && !/^file:\/\//.test(line)
    && !/^\^+$/.test(line)
    && !/^(throw|const|await|return|})\b/.test(line));
  return useful[0] ?? null;
}

// Arquivos que a build produziu — inclusive quando ela falhou no meio. Um
// projeto que morreu depois de escrever metade do site ainda tem metade do site
// em disco, e escondê-lo joga fora trabalho que já foi feito (e pago).
function projectFiles(project) {
  try {
    return readdirSync(project.output_dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = join(project.output_dir, entry.name);
        const { size, mtime } = statSync(full);
        return {
          name: entry.name,
          size_bytes: size,
          updated_at: mtime.toISOString(),
          url: `/projects/${project.id}/${entry.name}`,
          // Estes são o diário da build, não o produto dela.
          internal: ["codex-events.jsonl", "request.json", "result.json"].includes(entry.name),
          editable: /\.(html?|css|js|mjs|json|md|txt|svg)$/i.test(entry.name),
        };
      })
      .sort((a, b) => Number(a.internal) - Number(b.internal) || a.name.localeCompare(b.name));
  } catch { return []; }
}

// Default por motor: cada um tem seu proprio vocabulario de nomes de modelo.
const DEFAULT_ENGINE_MODEL = {
  codex: "gpt-5.6-sol",
  claude: "",
  ollama: "qwen3.6:35b-a3b",
  openrouter: process.env.OPENROUTER_MODEL_DEFAULT || "google/gemini-2.5-flash",
};


// Ajustes que a pessoa controla pela tela. Mesmo padrao dos modos e da curadoria:
// arquivo proprio em data/, so o que difere do padrao, apagavel sem quebrar nada.
const SETTINGS_FILE = join(DATA, "settings.json");
const SETTINGS_DEFAULTS = { catalog_refresh_hours: 6, website_reference: "", website_reference_url: "", document_reference: "" };

function readSettings() {
  if (!existsSync(SETTINGS_FILE)) return { ...SETTINGS_DEFAULTS };
  try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) }; }
  catch (error) { console.warn(`settings.json ilegivel (${error.message})`); return { ...SETTINGS_DEFAULTS }; }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  scheduleCatalogRefresh(next.catalog_refresh_hours);
  return next;
}

// O intervalo era fixo em 6h no codigo. Agora e ajustavel, e 0 significa
// "so quando eu mandar" — util para quem paga por chamada ou trabalha offline.
let catalogTimer = null;
function scheduleCatalogRefresh(hours) {
  if (catalogTimer) clearInterval(catalogTimer);
  catalogTimer = null;
  if (!hours || hours <= 0) return;
  catalogTimer = setInterval(() => {
    refreshCatalogDiscovery().catch((error) => console.warn(`catalog sync failed: ${error.message}`));
  }, hours * 60 * 60 * 1000);
  catalogTimer.unref();
}

function projectSlug(value) {
  return String(value || "untitled")
    .toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "untitled";
}

function publicProject(project) {
  if (!project) return null;
  // Builds que falharam ANTES desta correção guardaram o rodapé do stack trace
  // ("Node.js v24.13.0") como se fosse o motivo. O diário do agente continua em
  // disco, então dá para recuperar a causa real na leitura, em vez de exigir
  // que a pessoa rode tudo de novo só para ver uma mensagem decente.
  const storedError = project.status === "failed" && (!project.error || /^Node\.js v/.test(project.error))
    ? (agentFailureReason(project.output_dir) ?? project.error)
    : project.error;
  const entryName = project.entry_file?.split("/").at(-1);
  const artifactName = project.artifact_file?.split("/").at(-1);
  const bundleUrl = project.kind === "website" && project.status === "complete"
    ? `/api/projects/${project.id}/bundle`
    : null;
  return {
    ...project,
    output_dir: undefined,
    error: storedError,
    files: projectFiles(project),
    snapshots: projectSnapshots(project),
    entry_file: entryName ? `/projects/${project.id}/${entryName}` : null,
    artifact_file: artifactName ? `/projects/${project.id}/${artifactName}` : null,
    bundle_url: bundleUrl,
  };
}

// Um pedido em linguagem natural pode estragar um site que ja estava bom, e o
// arquivo sobrescrito nao volta sozinho. Cada revisao guarda o estado anterior
// antes de tocar em nada — sem isso, "escurece o fundo" mal interpretado custa
// a build inteira.
function snapshotProject(project) {
  const dir = join(project.output_dir, "history", String(Date.now()));
  mkdirSync(dir, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(project.output_dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (["request.json", "result.json", "codex-events.jsonl"].includes(entry.name)) continue;
    copyFileSync(join(project.output_dir, entry.name), join(dir, entry.name));
    copied++;
  }
  return { dir, copied };
}

function projectSnapshots(project) {
  const root = join(project.output_dir, "history");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ id: entry.name, at: new Date(Number(entry.name)).toISOString() }))
    .sort((a, b) => Number(b.id) - Number(a.id));
}

function startProjectBuild(project) {
  const requestPath = join(project.output_dir, "request.json");
  const request = {
    id: project.id,
    kind: project.kind,
    title: project.title,
    slug: projectSlug(project.title),
    prompt: project.prompt,
    template: project.template,
    model: project.model,
    reasoning: project.reasoning,
    engine: project.metadata?.engine_id || "codex",
    mode: project.metadata?.mode || "build",
    instruction: project.metadata?.instruction || null,
    output_dir: project.output_dir,
    reference_path: (() => {
      const ref = creativeReferences()[project.kind];
      return ref && existsSync(ref) ? ref : null;
    })(),
  };
  writeFileSync(requestPath, JSON.stringify(request, null, 2));
  const child = spawn(process.execPath, [join(HERE, "project_runner.mjs"), requestPath], {
    cwd: project.output_dir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  projectProcesses.set(project.id, child);
  let stdout = "";
  let stderr = "";
  store.updateProject(project.id, { status: "running", stage: "Starting Codex", progress: 3 });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      const match = line.match(/^BENCH_STAGE:(\d+):(.*)$/);
      if (!match) continue;
      const current = store.getProject(project.id);
      if (!current || current.status !== "running") continue;
      const progress = Number(match[1]);
      const stage = match[2].trim();
      store.updateProject(project.id, {
        progress,
        stage,
        stages: [...(current?.stages ?? []), { progress, stage, at: new Date().toISOString() }].slice(-20),
      });
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
  child.on("close", (code) => {
    projectProcesses.delete(project.id);
    // Cancellation is a deliberate terminal state. The SIGTERM used by the
    // cancel route also emits `close`; never reinterpret that exit as failure.
    if (store.getProject(project.id)?.status === "cancelled") return;
    if (code !== 0) {
      // A ÚLTIMA linha do stderr é quase sempre lixo: num crash do Node ela é
      // "Node.js v24.13.0", o rodapé do stack trace. Foi literalmente isso que a
      // tela mostrou numa falha real. O motivo de verdade costuma estar na
      // última mensagem que o próprio agente escreveu (ex.: "o sandbox do
      // workspace falhou ao iniciar: bwrap ... Operation not permitted").
      const message = agentFailureReason(project.output_dir)
        ?? stderrReason(stderr)
        ?? `Build exited with status ${code}`;
      store.updateProject(project.id, { status: "failed", stage: "Build stopped", error: message.slice(0, 1200) });
      return;
    }
    try {
      const result = JSON.parse(readFileSync(join(project.output_dir, "result.json"), "utf8"));
      store.updateProject(project.id, {
        status: "complete", stage: "Complete", progress: 100,
        entry_file: result.entry_file,
        artifact_file: result.artifact_file,
        preview_url: project.kind === "website" ? `/projects/${project.id}/index.html` : `/projects/${project.id}/document.html`,
      });
    } catch (error) {
      store.updateProject(project.id, { status: "failed", stage: "Artifact missing", error: error.message });
    }
  });
}

// ---------------------------------------------------------------- cost
//
// Two layers, and the second one is why this counter is trustworthy:
//
//   1. ESTIMATE, before you press go, from fal's live unit price and the params
//      you picked. This is what fills the "this will cost" preview.
//   2. ACTUAL, after it finishes. fal returns the real billed quantity in the
//      `x-fal-billable-units` response header, already denominated in whatever
//      unit that model bills in. actual = billable_units * unit_price.
//
// So the ledger records what fal charged, not what we guessed. Rows are tagged
// verified or estimated, and the UI says which.

// Live unit prices, pulled from fal at startup. No hardcoded price table.
let LIVE_PRICES = {}; // endpoint_id -> { unit_price, unit, currency }
let BILLING_CACHE = null;

const PRICE_CACHE = join(DATA, "prices.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFalBilling({ force = false } = {}) {
  if (!force && BILLING_CACHE && Date.now() - BILLING_CACHE.fetched_at_ms < 60000) return BILLING_CACHE;
  const topUpUrl = "https://fal.ai/dashboard/billing";
  try {
    const response = await fetch("https://api.fal.ai/v1/account/billing?expand=credits", {
      headers: { Authorization: `Key ${FAL_KEY}` },
    });
    if (response.status === 401 || response.status === 403) {
      BILLING_CACHE = {
        available: false,
        reason: "The current fal key can generate media but cannot read account billing.",
        top_up_url: topUpUrl,
        fetched_at: new Date().toISOString(),
        fetched_at_ms: Date.now(),
      };
      return BILLING_CACHE;
    }
    if (!response.ok) throw new Error(`fal billing HTTP ${response.status}`);
    const payload = await response.json();
    BILLING_CACHE = {
      available: true,
      account: payload.username ?? null,
      current_balance: payload.credits?.current_balance ?? null,
      currency: payload.credits?.currency ?? "USD",
      top_up_url: topUpUrl,
      fetched_at: new Date().toISOString(),
      fetched_at_ms: Date.now(),
    };
    return BILLING_CACHE;
  } catch (error) {
    return {
      available: false,
      reason: "Balance is temporarily unavailable. You can still add credits securely on fal.",
      top_up_url: topUpUrl,
      fetched_at: new Date().toISOString(),
      fetched_at_ms: Date.now(),
    };
  }
}

function readPriceCache() {
  if (!existsSync(PRICE_CACHE)) return {};
  try {
    return JSON.parse(readFileSync(PRICE_CACHE, "utf8"));
  } catch (e) {
    console.warn(`price cache unreadable: ${e.message}`);
    return {};
  }
}

// fal rate-limits this endpoint hard, so: small chunks, a pause between them,
// backoff on 429, and a disk cache so a throttled start still boots priced.
async function fetchLivePrices(ids) {
  const out = readPriceCache();

  for (let i = 0; i < ids.length; i += 5) {
    const chunk = ids.slice(i, i + 5);
    const qs = chunk.map((id) => `endpoint_id=${encodeURIComponent(id)}`).join("&");

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(`https://api.fal.ai/v1/models/pricing?${qs}`, {
          headers: { Authorization: `Key ${FAL_KEY}` },
        });
        if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
        if (!r.ok) { console.warn(`pricing ${r.status} on ${chunk[0]}`); break; }
        const j = await r.json();
        for (const p of j.prices ?? []) out[p.endpoint_id] = p;
        break;
      } catch (e) {
        await sleep(800 * (attempt + 1));
      }
    }
    await sleep(900);
  }

  try { writeFileSync(PRICE_CACHE, JSON.stringify(out, null, 2)); } catch {}
  return out;
}

// Units whose quantity cannot be predicted from the request. Anything billed
// in these gets no pre-run quote.
const OPAQUE_UNITS = new Set(["units", "compute seconds"]);

// How many billable units this request is likely to consume, given fal's unit.
function estimateUnits(modelId, params, unit) {
  const n = Number(params.num_images ?? 1) || 1;
  switch (unit) {
    case "megapixels":
      // fal rounds megapixels UP to the next whole unit, per model docs. A
      // 1024x1024 image is 1.048 MP and bills as 2. Skipping this undercounts.
      return Math.ceil(megapixels(params)) * n;
    case "seconds":
      return durationSeconds(modelId, params);
    case "images":
      return n;
    case "requests":
    case "generations":
      return 1;
    default:
      return 1;
  }
}

function estimateCost(modelId, params) {
  const live = LIVE_PRICES[modelId];
  const fallback = PRICING[modelId];
  if (!live && !fallback) return { cost: null, confidence: "unknown", basis: "no pricing available" };

  if (live) {
    // Some endpoints bill in an opaque "units" that has no relation to any
    // parameter you can see. Seedance reference billed 108.9 units on a 5
    // second clip, so a 1-unit guess would have been out by 100x. Refuse to
    // quote rather than quote a number that is wrong.
    if (OPAQUE_UNITS.has(live.unit)) {
      return {
        cost: null,
        confidence: "unquotable",
        basis: `billed per ${live.unit} at $${live.unit_price}, quantity is only known after the run`,
        unit: live.unit,
        unit_price: live.unit_price,
      };
    }
    const units = estimateUnits(modelId, params, live.unit);
    return {
      cost: Number((live.unit_price * units).toFixed(4)),
      confidence: "estimated",
      basis: `${units} ${live.unit} x $${live.unit_price}`,
      unit: live.unit,
      unit_price: live.unit_price,
    };
  }
  // researched table, only used if fal's pricing API is unreachable
  return {
    cost: fallback.price ?? null,
    confidence: "estimated (offline table)",
    basis: `${fallback.unit} @ $${fallback.price}`,
  };
}

// The real number. Called after the job completes, using the header fal sends.
function actualCost(modelId, billableUnits) {
  const live = LIVE_PRICES[modelId];
  if (!live || billableUnits == null) return null;
  return {
    cost: Number((live.unit_price * billableUnits).toFixed(4)),
    confidence: "verified",
    basis: `${billableUnits} ${live.unit} x $${live.unit_price} (billed by fal)`,
    unit: live.unit,
    unit_price: live.unit_price,
    billable_units: billableUnits,
  };
}

function durationSeconds(modelId, params) {
  const m = byId.get(modelId);
  const d = m?.params?.duration;
  const raw = params.duration ?? d?.default ?? d?.enum?.[0] ?? 5;
  const num = parseFloat(String(raw));
  return Number.isFinite(num) ? num : 5;
}

// fal's named size presets, so a megapixel-billed model can be priced before
// the request goes out rather than after.
const SIZE_PRESETS = {
  square_hd:        [1024, 1024],
  square:           [512, 512],
  portrait_4_3:     [768, 1024],
  portrait_16_9:    [576, 1024],
  landscape_4_3:    [1024, 768],
  landscape_16_9:   [1024, 576],
};

function megapixels(params) {
  const s = params.image_size;
  if (s && typeof s === "object" && s.width && s.height) return (s.width * s.height) / 1e6;
  if (typeof s === "string" && SIZE_PRESETS[s]) {
    const [w, h] = SIZE_PRESETS[s];
    return (w * h) / 1e6;
  }
  if (params.width && params.height) return (params.width * params.height) / 1e6;
  return 1.048; // model default is almost always 1024x1024
}

// ---------------------------------------------------------------- ledger

// Uma referência mandada como data URI chega aqui com o arquivo INTEIRO em
// base64 — 2 MB para uma imagem comum. Guardar isso no recibo engorda o banco e,
// pior, o /api/ledger passa a trafegar megabytes a cada abertura da tela (foi
// medido: 8 MB de resposta por causa de DUAS linhas). O recibo precisa registrar
// que houve um anexo e qual, não carregar os bytes dele.
const DATA_URI_LIMIT = 512;

function compactValue(value) {
  // Campo de midia com aridade multipla chega como ARRAY de data URIs — foi o
  // que sobrou pesando depois da primeira correcao, que so tratava string.
  if (Array.isArray(value)) return value.map(compactValue);
  if (typeof value !== "string" || !value.startsWith("data:") || value.length <= DATA_URI_LIMIT) return value;
  const mime = value.slice(5, value.indexOf(";")) || "arquivo";
  return `data:${mime};base64,[${(value.length / 1024 / 1024).toFixed(1)} MB não guardados no recibo]`;
}

function compactRow(row) {
  if (!row || typeof row !== "object") return row;
  const params = row.params ? Object.fromEntries(Object.entries(row.params).map(([k, v]) => [k, compactValue(v)])) : row.params;
  const inputAssets = Array.isArray(row.input_assets)
    ? row.input_assets.map((asset) => ({ ...asset, url: compactValue(asset?.url) }))
    : row.input_assets;
  return { ...row, params, input_assets: inputAssets };
}

function appendLedger(row) {
  return store.addGeneration(compactRow(row));
}

function readLedger() {
  // Também na leitura: linhas gravadas antes desta correção continuam gordas no
  // banco, e sem isto seguiriam pesando na resposta para sempre.
  return store.listGenerations(500).map(compactRow);
}

function spendSummary() {
  return store.spendSummary();
}

// ---------------------------------------------------------------- prompt optimizer

// Rewrite a casual idea into a prompt shaped for the specific model, using the
// researched profile. This is the piece Higgsfield calls a "pre-trained backend".
function findProfile(modelId) {
  if (PROFILES[modelId]) return PROFILES[modelId];
  // Fall back to a same-family, same-modality profile. Endpoint ids churn every
  // few months; the way a family wants to be prompted moves much slower.
  const m = byId.get(modelId);
  if (!m) return null;
  const wantVideo = m.kind === "video";
  const candidates = Object.entries(PROFILES).filter(([id, p]) => {
    const isVideo = String(p.modality ?? "").includes("video");
    if (isVideo !== wantVideo) return false;
    return sameFamily(id, modelId);
  });
  return candidates[0]?.[1] ?? null;
}

// Families, as alias groups. One vendor can appear under several names across
// endpoint generations (minimax/hailuo/h3 are all the same model line), so a
// single-token match would miss the very case the fallback exists for.
const FAMILIES = {
  gemini:   ["nano-banana"],
  openai:   ["gpt-image"],
  seedream: ["seedream"],
  qwen:     ["qwen-image"],
  flux:     ["flux"],
  recraft:  ["recraft"],
  grok:     ["grok"],
  kling:    ["kling"],
  seedance: ["seedance"],
  hailuo:   ["hailuo", "minimax", "/h3/"],
  wan:      ["wan"],
  ltx:      ["ltx"],
  veo:      ["veo"],
  hunyuan:  ["hunyuan"],
};

function familyOf(id) {
  const s = `/${id}/`;
  for (const [fam, tokens] of Object.entries(FAMILIES)) {
    if (tokens.some((t) => s.includes(t))) return fam;
  }
  return null;
}

function sameFamily(a, b) {
  const fa = familyOf(a);
  return Boolean(fa) && fa === familyOf(b);
}

// Modos personalizados: aditivos aos de fabrica, nunca sobrescrevem.
// `isReserved` como funcao, e nao lista: FORMATS so existe mais abaixo no
// modulo, e a checagem so acontece quando alguem salva um modo.
const catalogPrefs = createCatalogPrefs({ dataDir: DATA });
const modesStore = createModesStore({ dataDir: DATA, isReserved: (id) => Boolean(FORMATS[id]) });
function customModes() { return modesStore.list(); }
function briefFor(format) {
  if (FORMATS[format]) return FORMATS[format].brief ?? "";
  return customModes().find((m) => m.id === format)?.brief ?? "";
}

function shotDirectionLines(shotSettings = {}) {
  return Object.entries(shotSettings)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim())
    .map(([key, value]) => `${key.replace(/_/g, " ")}: ${String(value).slice(0, 180)}`);
}

function imageInputForModel(model) {
  if (model?.image_input?.name && model.image_input.arity) return model.image_input;
  if (model?.image_param && model.accepts_image) {
    return { name: model.image_param, arity: model.accepts_image };
  }
  return null;
}

async function optimizePrompt({ idea, modelId, format, hasReference, refCount = 0, params = {}, shotSettings = {} }) {
  const profile = findProfile(modelId);
  const model = byId.get(modelId);
  if (!profile) return { prompt: idea, optimized: false, reason: "no profile for this model yet" };

  const formatBrief = format === "ugc"
    ? ugcBrief({ model, modelId, hasReference, refCount })
    : briefFor(format);

  // The aspect ratio, duration and resolution are sent as real parameters, so
  // the prompt must not argue with them. Writing "vertical 9:16" into a prompt
  // submitted at 4:5 is how you get a fight between the text and the request.
  const settingsBrief = Object.entries(params)
    .filter(([k, v]) => v !== undefined && v !== "" &&
      ["aspect_ratio", "duration", "resolution", "image_size", "fps", "num_images"].includes(k))
    .map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`)
    .join("\n");
  const refRules = hasReference
    ? (profile.reference_image_prompt_rules ?? []).join("\n- ")
    : "";
  const directionLines = shotDirectionLines(shotSettings);

  const sys = `You rewrite a casual creative idea into ONE prompt tuned for a specific generative model.

MODEL: ${model?.label ?? modelId} (${model?.vendor ?? "?"}), ${profile.modality ?? model?.lane}

HOW THIS MODEL WANTS TO BE PROMPTED:
${profile.prompt_style ?? ""}

STRUCTURE TO FOLLOW:
${profile.structure_template ?? ""}

TARGET LENGTH: ${(profile.ideal_length_words ?? [30, 80]).join(" to ")} words

DO:
- ${(profile.do ?? []).join("\n- ")}

DO NOT:
- ${(profile.dont ?? []).join("\n- ")}
${profile.motion_vocabulary ? `\nCAMERA VOCABULARY THIS MODEL RESPONDS TO:\n- ${profile.motion_vocabulary.join("\n- ")}` : ""}
${formatBrief ? `\nFORMAT THE USER PICKED:\n${formatBrief}` : ""}
${directionLines.length ? `\nCREATIVE DIRECTION SELECTED BY THE USER:\n- ${directionLines.join("\n- ")}\nUse these choices to make the prompt concrete. Do not mention the control labels or describe this as a preset.` : ""}
${settingsBrief ? `\nSETTINGS ALREADY LOCKED ON THE REQUEST. Never contradict these in the prompt text, and never restate them as words:\n${settingsBrief}` : ""}
${refRules ? `\n${refCount === 1 ? "EXACTLY ONE reference image is attached. Never refer to a second, third or 'background' image; anything not in that one image must be described in words instead." : `EXACTLY ${refCount} reference images are attached, in order.`}\nThese rules are mandatory:\n- ${refRules}` : ""}

Return ONLY the rewritten prompt. No preamble, no quotes, no explanation, no markdown.`;

  const body = {
    contents: [{ role: "user", parts: [{ text: `Idea: ${idea}` }] }],
    systemInstruction: { parts: [{ text: sys }] },
    generationConfig: {
      temperature: 0.7,
      // Thinking tokens are drawn from this same budget, so a tight cap here
      // truncates the answer mid-sentence. Give it room and turn thinking off,
      // since this is a rewrite task with the rules already supplied.
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  // O refino não é enfeite: para a Agnes ele é o que traduz a ideia para inglês,
  // e sem isso a API recusa português com HTTP 400. Um único rewriter significa
  // que a cota dele derruba o estúdio inteiro — foi o que aconteceu em
  // 2026-08-16, quando o free tier do Gemini bateu
  // `GenerateRequestsPerDayPerProjectPerModel-FreeTier` e TODOS os modelos
  // passaram a receber o prompt cru, em português. Por isso: uma cadeia.
  const rewriters = [
    { name: "gemini-3-flash-preview", run: () => rewriteWithGemini(body) },
    { name: "openrouter", run: () => rewriteWithOpenRouter(sys, idea) },
    { name: "codex", run: () => rewriteWithCodex(sys, idea) },
  ];

  const failures = [];
  for (const rewriter of rewriters) {
    try {
      const text = await rewriter.run();
      if (text) {
        return {
          prompt: text,
          optimized: true,
          profile_used: profile.family ?? modelId,
          rewriter: rewriter.name,
          // Quem assumiu importa: se o primeiro caiu, dizer isso evita a
          // suspeita de que o perfil do modelo é que parou de funcionar.
          fallback_from: failures.length ? failures.map((f) => f.name) : undefined,
        };
      }
      failures.push({ name: rewriter.name, reason: "resposta vazia" });
    } catch (error) {
      failures.push({ name: rewriter.name, reason: String(error.message ?? error).slice(0, 120) });
    }
  }
  return {
    prompt: idea,
    optimized: false,
    reason: `nenhum rewriter disponível: ${failures.map((f) => `${f.name} (${f.reason})`).join("; ")}`,
  };
}

async function rewriteWithGemini(body) {
  if (!GOOGLE_API_KEY) throw new Error("sem GOOGLE_API_KEY");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GOOGLE_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim();
}

async function rewriteWithOpenRouter(sys, idea) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("sem OPENROUTER_API_KEY");
  // O modelo configurado no ambiente pode ter sido aposentado: o
  // OPENROUTER_MODEL_DEFAULT herdado do imkt5 era `gemini-2.0-flash-exp:free`,
  // que o OpenRouter respondeu com 404 "No endpoints found" em 2026-08-16. Um
  // default do ambiente que envelheceu não pode derrubar o elo inteiro da
  // cadeia, então há um segundo candidato conhecido.
  const candidates = [process.env.OPENROUTER_MODEL_DEFAULT, "google/gemini-2.5-flash"].filter(Boolean);
  let last;
  for (const model of candidates) {
    const res = await fetch(`${process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: sys }, { role: "user", content: `Idea: ${idea}` }],
        temperature: 0.7,
        // MEDIDO 2026-08-16: sem este teto o OpenRouter reserva 65535 tokens e
        // recusa a conta com HTTP 402 ("You requested up to 65535 tokens, but
        // can only afford 10535"). Uma reescrita de prompt cabe em centenas de
        // tokens, então o teto não corta nada e mantém o elo vivo mesmo com
        // saldo baixo.
        max_tokens: 1000,
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (res.ok) {
      const j = await res.json();
      const text = j.choices?.[0]?.message?.content?.trim();
      if (text) return text;
      last = new Error(`${model}: resposta vazia`);
      continue;
    }
    last = new Error(`${model}: HTTP ${res.status}`);
    // 404 = modelo inexistente, vale tentar o próximo. Outros erros (401, 402,
    // 429) valem para a conta inteira: trocar de modelo não resolve.
    if (res.status !== 404) break;
  }
  throw last;
}

// Último recurso: o Codex já está instalado e autenticado para os workspaces de
// Website e Document, então reescrever um prompt não custa chave nova nem
// dinheiro novo. Sem rede e sem escrita em disco — é só texto.
async function rewriteWithCodex(sys, idea) {
  const { Codex } = await import("@openai/codex-sdk");
  const codex = new Codex({
    config: { features: { apps: false, browser_use: false, computer_use: false, image_generation: false, multi_agent: false, plugins: false, skill_search: false } },
  });
  const thread = codex.startThread({
    workingDirectory: DATA,
    model: "gpt-5.6-sol",
    modelReasoningEffort: "low",
    sandboxMode: "read-only",
    networkAccessEnabled: false,
    skipGitRepoCheck: true,
    webSearchMode: "disabled",
    webSearchEnabled: false,
    approvalPolicy: "never",
  });
  const turn = await thread.run(`${sys}\n\nIdea: ${idea}`);
  const text = String(turn?.finalResponse ?? "").trim();
  // O Codex conversa por natureza; o contrato aqui é devolver só o prompt.
  return text.replace(/^```[a-z]*\n?|```$/g, "").trim();
}

// The format presets. This is the Marketing-Studio layer, except you can read it —
// e, com a aba Modes, tambem editar sem tocar em codigo.
const FORMATS = {
  none: { label: "Freeform", brief: "" },
  ugc: {
    label: "UGC",
    brief:
      "A direct-response creator ad, built as one believable social-native beat rather than a polished commercial. Keep one creator, one product, one setting, and one clear action. Use phone-native framing, natural light, slight handheld imperfection, and a real reaction. If the idea includes a spoken line, keep it short, conversational, and faithful to the user's words; never invent a product claim. Use the actual aspect ratio and duration controls instead of restating them in the prompt. For a short clip, make the beat: hook or problem, product interaction or proof, then a natural reaction. Do not write a montage, scene changes, captions, or extra people unless the user asks for them.",
  },
  unboxing: {
    label: "Unboxing",
    brief:
      "Top-down or over-the-shoulder view of hands opening packaging and revealing the product. Tactile close-ups of the box, the lid, the reveal. Warm domestic surface, shallow depth of field, no faces needed.",
  },
  hypermotion: {
    label: "Hyper Motion",
    brief:
      "High-energy product film. Fast camera moves, whip transitions, macro detail shots, the product suspended or rotating, dramatic rim lighting against a dark ground. Every second changes. Premium launch-film energy.",
  },
  tvspot: {
    label: "TV Spot",
    brief:
      "Cinematic commercial framing. Locked-off or slow dolly, filmic color, a single clear hero composition, product centered and lit like a luxury ad. Calm, expensive, confident.",
  },
  product: {
    label: "Product Still",
    brief:
      "Clean studio product photography. Seamless sweep background, controlled soft lighting with one crisp specular highlight, product perfectly in focus and centered, catalogue-grade.",
  },
  poster: {
    label: "Ad with Headline",
    brief:
      "A social-ready advertisement image with legible on-image headline text. Leave deliberate empty space for the headline, keep the type short and high-contrast, and make sure the words are spelled correctly and fully visible.",
  },
};

// UGC is a shared creative intent, not a shared prompt dialect. These adapters
// carry the documented shape of each family into the common UGC brief so the
// rewriter can keep the workflow simple without flattening model differences.
const UGC_FAMILY_RULES = {
  flux: "For an image, make this a candid phone or 2000s digicam creator frame: one person, one product, one readable gesture, natural indoor light, and enough separation for the product to read. Use short positive prose, subject first, and never write negative instructions because FLUX has no negative prompt.",
  gemini: "For an image, write a natural scene description with the creator and product roles explicit. If references are attached, identify each by role and preserve the product or face instead of re-describing it. Keep any new on-image copy short and quote it exactly only when requested.",
  openai: "For an image, use a plain designer brief: deliverable, creator action, product placement, composition, and lighting. Keep it compact. Avoid dense copy, pixel-exact layout promises, or a long cinematic paragraph; GPT Image is better at the visual than precise ad typography.",
  recraft: "For an image, use a concise controlled description. State the creator, product, composition, and visual style. If a brand layout or headline matters, specify the hierarchy and exact short text directly; keep the rest of the scene simple.",
  seedream: "For an image, describe one candid creator moment with a clear product action and simple social composition. Keep the scene concrete and avoid stacking many props, claims, or text elements.",
  qwen: "For an image, keep an entity → action → scene → style order. Make the creator's gesture and the product's position explicit, but do not turn the prompt into a list of ad buzzwords.",
  kling: "For video, follow Subject → Movement → Scene → Camera → Lighting. Make one primary camera move and one human action fit the requested duration. With a reference image, prompt motion and delivery only; do not redraw the anchored person's appearance or product.",
  veo: "For video, explicitly describe the subject, action, camera framing or move, natural lighting, and optional audio. A short spoken line may be included when the endpoint supports audio. Use positive phrasing instead of a negative prompt, and keep the performance natural rather than over-directed.",
  seedance: "For video, write a chronological action beat. Use explicit shot changes or time ranges only when the requested duration can support them; otherwise keep one hook → proof → reaction beat. When references are attached, keep their roles explicit and use the model's reference identifiers only when they are available in the request.",
  hailuo: "For video, write one flowing paragraph with one creator action and one camera move. Keep delivery natural and do not overpack the clip. With a reference image, describe motion and camera only and keep the product or person unchanged.",
  wan: "For video, follow Entity/Reference → Action → Scene → Lines → Sound. For a reference request, identify the uploaded image as Image 1 when more than one reference exists. Say 'Generate single shot' for a short one-beat UGC clip; use timestamped multi-shot structure only when the user asks for a multi-shot ad.",
  ltx: "For video, write one chronological paragraph under 200 words: creator action, product interaction, camera movement, then atmosphere or audio if supported. One flowing take is more reliable than a montage or a list of shots.",
  grok: "For video, use a concise natural-language request with one clear creator action and one camera idea. For reference-to-video, say what the reference should preserve and what should change; never mix a first-frame image and reference-image mode in the same request.",
};

function ugcBrief({ model, modelId, hasReference, refCount }) {
  const family = familyOf(modelId);
  const isVideo = model?.kind === "video";
  const lane = model?.lane ?? "t2i";
  const referenceNote = hasReference
    ? `REFERENCE MODE: ${refCount === 1 ? "one reference image" : `${refCount} reference images`} is attached. Preserve the anchored subject and product. For image-to-video or reference-to-video, describe only the action, expression, camera, and time-based change unless the model-specific rule below explicitly requires more.`
    : "No reference image is attached. The prompt must establish the creator, product, setting, and action itself.";
  const laneNote = lane === "r2v"
    ? "This is a reference-to-video lane: preserve the product or creator from the reference and stage a single believable UGC delivery moment around it."
    : lane === "i2v"
    ? "This is an image-to-video lane: treat the uploaded image as the starting frame and prompt motion, camera, expression, and product interaction rather than inventing a new look."
    : lane === "i2i"
    ? "This is an image-edit lane: make the requested edit explicit and keep the creator/product identity stable."
    : "This is a text-to-generation lane: establish one creator, one product, one setting, and one ad beat from scratch.";
  const mediumNote = isVideo
    ? "MEDIUM: VIDEO. Do not write a full 30-second script. Return one short filmable beat that can fit the selected duration."
    : "MEDIUM: IMAGE. Create the key UGC frame or thumbnail, not a spoken script. Show the creator's expression, product interaction, and phone-native context in one still.";
  return [
    FORMATS.ugc.brief,
    mediumNote,
    laneNote,
    referenceNote,
    UGC_FAMILY_RULES[family] ?? "Use plain, concrete language: one creator, one product action, one setting, one camera idea, and one natural payoff.",
  ].join("\n\n");
}

// ---------------------------------------------------------------- fal calls

const FAL_QUEUE = "https://queue.fal.run";

async function falSubmit(modelId, input) {
  const res = await fetch(`${FAL_QUEUE}/${modelId}`, {
    method: "POST",
    headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`fal submit ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

function publicProviderError(error, context = "generation") {
  const raw = String(error?.message ?? error ?? "");
  const lower = raw.toLowerCase();
  if (lower.includes("exhausted balance") || lower.includes("user is locked")) {
    return context === "upload"
      ? "Your fal balance is empty, so the reference cannot be uploaded. Add credits and try again."
      : "Your fal balance is empty. Add credits and try this generation again.";
  }
  if (lower.includes("content_policy_violation")) {
    return "The model declined this request because of its content policy. Adjust the prompt or reference and try again.";
  }
  if (/\b401\b|\b403\b/.test(lower)) {
    return "fal rejected the current API credentials. Check the configured key and account access.";
  }
  if (/\b422\b/.test(lower)) {
    return "This model could not accept one of the selected settings. Review the model controls and try again.";
  }
  // Antes, tudo que não casasse com os casos acima virava "a geração não pôde
  // ser iniciada, tente de novo". Isso escondeu dois bugs reais nesta sessão
  // (`flux2-klein/edit` -> 404 e `agnes-image-2.1-flash/edit` -> model_not_found):
  // a tela dizia "tente de novo" para um erro que nunca ia melhorar tentando.
  // Os adapters escrevem mensagens específicas de propósito — repassá-las é o
  // ponto. Só a chave é redigida, porque ela nunca deve sair daqui.
  const safe = raw
    .replace(/(Key|Bearer)\s+[A-Za-z0-9._:-]{8,}/gi, "$1 [redigida]")
    .replace(/([?&](api_?key|token|key)=)[^&\s]+/gi, "$1[redigida]")
    .trim();
  if (safe) return safe.slice(0, 400);
  return context === "upload"
    ? "The reference could not be uploaded. Please try again."
    : "The generation could not be started. Please try again.";
}

// Status/result live under the base model path, not the sub-path.
function baseOf(modelId) {
  const parts = modelId.split("/");
  return parts.length > 2 ? `${parts[0]}/${parts[1]}` : modelId;
}

async function falPoll(modelId, requestId, { onUpdate } = {}) {
  const base = baseOf(modelId);
  const statusUrl = `${FAL_QUEUE}/${base}/requests/${requestId}/status`;
  const resultUrl = `${FAL_QUEUE}/${base}/requests/${requestId}`;
  const started = Date.now();
  const TIMEOUT_MS = 12 * 60 * 1000;

  while (Date.now() - started < TIMEOUT_MS) {
    const r = await fetch(statusUrl, { headers: { Authorization: `Key ${FAL_KEY}` } });
    if (!r.ok) throw new Error(`fal status ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const s = await r.json();
    onUpdate?.(s);
    if (s.status === "COMPLETED") {
      const rr = await fetch(resultUrl, { headers: { Authorization: `Key ${FAL_KEY}` } });
      if (!rr.ok) throw new Error(`fal result ${rr.status}: ${(await rr.text()).slice(0, 300)}`);
      // Read the header BEFORE the body; this is the real billed quantity.
      const raw = rr.headers.get("x-fal-billable-units");
      const billableUnits = raw == null ? null : Number(raw);
      return {
        result: await rr.json(),
        billableUnits: Number.isFinite(billableUnits) ? billableUnits : null,
      };
    }
    if (s.status === "FAILED" || s.status === "ERROR") {
      throw new Error(`generation failed: ${JSON.stringify(s).slice(0, 400)}`);
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("timed out after 12 minutes");
}

// ---------------------------------------------------------------- providers
//
// One interface, N backends. Ported from ~/projetos/videoanima-skill/provedores.py,
// which already runs this exact shape in production (agnes | inemaimg | kie).
// Its rule holds here too:
//
//   "As armadilhas MEDIDAS de cada API moram no adaptador dela, nunca no
//    nucleo -- sao especificas do provedor."
//
// So retries, poll spacing, param quirks and auth live inside an adapter.
// Everything the core does -- input validation, the ledger, mirroring outputs
// -- stays provider-agnostic and is written exactly once.
//
// Contract, per adapter:
//   submit(modelId, input)            -> { request_id, ... }   provider-specific handle
//   poll(modelId, handle, {onUpdate}) -> { result, billableUnits }
//   quote(modelId, input)             -> { cost, confidence, basis, ... } | before the run
//   actual(modelId, billableUnits)    -> same shape | null     | after the run
//
// A model declares its backend with `provider` in the registry. Absent means
// "fal", so the 37 curated fal routes keep working with no registry change.

const PROVIDERS = {
  fal: {
    label: "fal.ai",
    // A fila do fal so aceita URL publica.
    accepts: { dataUri: false },
    availability: () => FAL_KEY
      ? { available: true }
      : { available: false, reason: "Falta FAL_KEY", hint: "Crie em fal.ai/dashboard/keys. Cobra em dolar, com preco ao vivo." },
    submit: (modelId, input) => falSubmit(modelId, input),
    poll: (modelId, handle, opts) => falPoll(modelId, handle.request_id, opts),
    quote: (modelId, input) => estimateCost(modelId, input),
    actual: (modelId, billableUnits) => actualCost(modelId, billableUnits),
  },
  agnes: agnesProvider,
  // Local: grava o PNG direto em OUTPUTS, por isso precisa saber onde é.
  inemaimg: createInemaimgProvider({ outputsDir: OUTPUTS }),
  kie: kieProvider,
  // O adapter precisa saber quais params o modelo declara: mandar flag que o
  // modelo nao declara faz o CLI recusar.
  kling: createKlingProvider({ modelById: (id) => byId.get(id) }),
};


// ---------------------------------------------------------------- disponibilidade
//
// Disponibilidade e FATO (a chave existe? o servico responde?), preferencia e
// outra coisa (eu quero ver este modelo?). Misturar as duas faz um modelo sumir
// sem que ninguem saiba se e por falta de chave ou por escolha — e ai nao da
// para agir. Aqui so mora o fato; ele nunca e gravado, porque muda sozinho.
const AVAILABILITY_TTL_MS = 60_000;
let availabilityCache = { at: 0, value: null, promise: null };

async function providerAvailability({ force = false } = {}) {
  if (!force && availabilityCache.value && Date.now() - availabilityCache.at < AVAILABILITY_TTL_MS) {
    return availabilityCache.value;
  }
  if (availabilityCache.promise) return availabilityCache.promise;
  availabilityCache.promise = (async () => {
    const entries = await Promise.all(Object.entries(PROVIDERS).map(async ([name, adapter]) => {
      try {
        const status = adapter.availability ? await adapter.availability() : { available: true };
        return [name, { label: adapter.label, ...status }];
      } catch (error) {
        return [name, { label: adapter.label, available: false, reason: String(error.message ?? error).slice(0, 160) }];
      }
    }));
    const value = Object.fromEntries(entries);
    availabilityCache = { at: Date.now(), value, promise: null };
    return value;
  })();
  return availabilityCache.promise;
}

// free = o provedor declara custo zero agora · credits = consome credito de um
// plano (nao da para somar com dolar) · paid = cobra em dolar · unknown = nao da
// para saber antes de rodar.
function costClassOf(model) {
  try {
    const quote = adapterFor(model).quote(model.id, {});
    if (quote?.unit === "credits") return "credits";
    if (quote?.cost === 0) return "free";
    if (typeof quote?.cost === "number" && quote.cost > 0) return "paid";
    return "unknown";
  } catch { return "unknown"; }
}

const DEFAULT_PROVIDER = "fal";
const providerOf = (model) => model?.provider ?? DEFAULT_PROVIDER;
function adapterFor(model) {
  const name = providerOf(model);
  const adapter = PROVIDERS[name];
  if (!adapter) throw new Error(`unknown provider ${name} for ${model?.id}`);
  return adapter;
}
// fal-only chores (live pricing, catalog staleness) must never be handed a
// foreign model id, or fal answers "unknown endpoint" for something that was
// never its endpoint to begin with.
const falModels = () => registry.models.filter((m) => providerOf(m) === "fal");

async function falUpload(buffer, filename, contentType) {
  // fal's storage: ask for a signed upload URL, PUT the bytes, get back a
  // public file_url you can hand to any model as image_url.
  const init = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate", {
    method: "POST",
    headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: filename, content_type: contentType }),
  });
  if (!init.ok) throw new Error(`upload initiate ${init.status}: ${(await init.text()).slice(0, 300)}`);
  const { upload_url, file_url } = await init.json();
  const put = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: buffer,
  });
  if (!put.ok) throw new Error(`upload put ${put.status}`);
  return file_url;
}

const CONTENT_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "application/pdf": ".pdf",
};

function mediaTypeFor(contentType = "") {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "application/pdf") return "document";
  return "file";
}

// Extensões que realmente identificam mídia. Aceitar qualquer coisa que "pareça
// extensão" faz o arquivo herdar sufixo inventado pelo provider: a URL do Kling
// termina em `.origin`, e um PNG de 1.3 MB era gravado como `.origin` — o
// sistema operacional, o navegador e o preview passam a não saber o que é.
// O content-type da resposta é a fonte melhor quando a URL não ajuda.
const KNOWN_EXTENSIONS = new Set(Object.values(CONTENT_EXTENSIONS));
const CONTENT_EXTENSIONS_REVERSE = Object.fromEntries(
  Object.entries(CONTENT_EXTENSIONS).map(([mime, ext]) => [ext, mime]),
);

function safeExtension(filename, contentType) {
  const extension = extname(filename ?? "").toLowerCase();
  if (KNOWN_EXTENSIONS.has(extension)) return extension;
  if (CONTENT_EXTENSIONS[contentType]) return CONTENT_EXTENSIONS[contentType];
  // Sem pista nenhuma: preserva a extensão da URL se for plausível, em vez de
  // esconder tudo atrás de .bin.
  if (/^\.[a-z0-9]{1,6}$/.test(extension)) return extension;
  return ".bin";
}

function localUploadCopy(file) {
  const uploadId = randomUUID();
  const filename = `${Date.now()}-${uploadId.slice(0, 8)}${safeExtension(file.originalname, file.mimetype)}`;
  const localPath = join(INPUTS, filename);
  writeFileSync(localPath, file.buffer);
  return {
    upload_id: uploadId,
    original_name: file.originalname,
    media_type: mediaTypeFor(file.mimetype),
    content_type: file.mimetype,
    size_bytes: file.size,
    local_path: localPath,
    local_url: `/inputs/${filename}`,
    created_at: new Date().toISOString(),
  };
}


// Referencia que aponta para um arquivo NOSSO (/media/... ou /inputs/...) e um
// caminho relativo: so este servidor sabe resolve-lo. Mandado assim para um
// provedor remoto, ele responde o obvio —
//   "image must be a public http(s) URL or valid base64 image data"
// — que foi exatamente o que aconteceu quando o Redo recarregou uma referencia
// vinda do arquivo local.
//
// Cada provedor aceita uma coisa: a Agnes aceita base64, o CLI do Kling aceita
// caminho local, o kie e o fal exigem URL publica. Entao o nucleo resolve o
// arquivo e entrega no formato que AQUELE provedor entende.
const LOCAL_URL_ROOTS = { "/media/": () => OUTPUTS, "/inputs/": () => INPUTS };

function localFileFor(url) {
  for (const [prefix, dirOf] of Object.entries(LOCAL_URL_ROOTS)) {
    if (!String(url).startsWith(prefix)) continue;
    const name = basename(decodeURIComponent(String(url).slice(prefix.length)));
    const full = join(dirOf(), name);
    return existsSync(full) ? full : null;
  }
  return null;
}

async function resolveAssetForProvider(url, adapter) {
  if (typeof url !== "string" || !url) return url;
  if (/^https?:\/\//i.test(url) || url.startsWith("data:")) return url;
  const local = localFileFor(url);
  if (!local) return url;

  if (adapter?.accepts?.localPath) return local;
  if (adapter?.accepts?.dataUri !== false) {
    const bytes = readFileSync(local);
    const type = CONTENT_EXTENSIONS_REVERSE[extname(local).toLowerCase()] ?? "image/png";
    return `data:${type};base64,${bytes.toString("base64")}`;
  }
  // Sobrou quem exige URL publica: sobe para o storage do fal, que ja e o
  // caminho normal dos anexos da interface.
  const bytes = readFileSync(local);
  const type = CONTENT_EXTENSIONS_REVERSE[extname(local).toLowerCase()] ?? "application/octet-stream";
  return falUpload(bytes, basename(local), type);
}

async function mirrorRemoteAsset(remoteUrl, identity, position = 0) {
  const response = await fetch(remoteUrl);
  if (!response.ok || !response.body) throw new Error(`media download HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";")[0] ?? null;
  const extension = safeExtension(new URL(remoteUrl).pathname, contentType);
  const safeIdentity = String(identity || randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 90);
  const filename = `${safeIdentity}-${position}${extension}`;
  const localPath = join(OUTPUTS, filename);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(localPath));
  return { local_path: localPath, local_url: `/media/${filename}`, content_type: contentType };
}

async function mirrorOutputs(outputs, requestId) {
  const mirrored = [];
  for (let index = 0; index < outputs.length; index++) {
    const output = outputs[index];
    // Provider local (inemaimg e afins) já escreve o arquivo em disco: não há
    // nada remoto para espelhar. Espelhar mesmo assim faria o servidor baixar
    // de si próprio e guardar uma segunda cópia do mesmo PNG.
    if (output.local_path) { mirrored.push({ ...output, remote_url: output.remote_url ?? null }); continue; }
    try {
      const local = await mirrorRemoteAsset(output.url, requestId, index);
      mirrored.push({ ...output, ...local, remote_url: output.url });
    } catch (error) {
      console.warn(`media mirror failed for ${output.url}: ${error.message}`);
      mirrored.push({ ...output, remote_url: output.url, mirror_error: error.message });
    }
  }
  return mirrored;
}

async function backfillMediaMirrors() {
  const missing = store.missingOutputAssets(80);
  let mirrored = 0;
  for (const asset of missing) {
    try {
      const local = await mirrorRemoteAsset(asset.remote_url, asset.request_id || `legacy-${asset.generation_id}`, asset.position);
      store.updateAssetMirror(asset.id, {
        localPath: local.local_path,
        localUrl: local.local_url,
        contentType: local.content_type,
      });
      mirrored++;
    } catch (error) {
      console.warn(`legacy media mirror failed: ${error.message}`);
    }
  }
  if (mirrored) console.log(`mirrored ${mirrored} historical outputs locally`);
}

// ---------------------------------------------------------------- app

const app = express();
app.use(express.json({ limit: "25mb" }));
// ---------------------------------------------------------------- senha
//
// Sem BENCH_PASSWORD, `authenticated()` devolve true para todo mundo e nada
// disto muda o comportamento de hoje. Com senha, a tranca cobre a API E os
// estaticos: os arquivos gerados sao tao seus quanto o historico, e deixar
// /media aberto entregaria as imagens a quem soubesse o caminho.
const auth = createAuth();

app.get("/api/auth", (req, res) => {
  res.json({ required: auth.required(), authenticated: auth.authenticated(req), local: isLoopback(req) });
});

app.post("/api/login", async (req, res) => {
  const r = await auth.login(req, res, req.body?.password);
  if (!r.ok) return res.status(401).json(r);
  res.json({ ok: true, required: auth.required() });
});

app.post("/api/logout", (req, res) => {
  auth.logout(req, res);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (auth.authenticated(req)) return next();
  // Uma requisicao de mídia sem sessao nao deve devolver JSON: quem pediu era um
  // <img>, e um 401 seco e a resposta honesta.
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Authentication required.", auth_required: true });
  res.status(401).end();
});

app.use("/media", express.static(OUTPUTS, { fallthrough: false }));
app.use("/previews", express.static(PREVIEWS, { fallthrough: false }));
app.use("/inputs", express.static(INPUTS, { fallthrough: false }));
app.use("/projects", express.static(PROJECTS, { fallthrough: false, index: false }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 120 * 1024 * 1024 } });

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    models: registry.models.length,
    schema_source: registry.source,
    image_input_models: registry.models.filter((model) => imageInputForModel(model)).length,
    profiles: Object.keys(PROFILES).length,
    priced: Object.keys(PRICING).filter((k) => k[0] !== "_").length,
    catalog_synced_at: CATALOG_SYNC?.synced_at ?? null,
    discovered_new_endpoints: CATALOG_SYNC?.new_endpoint_count ?? null,
    persistence: "sqlite",
    storage: store.storageSummary(),
    rewriter: [GOOGLE_API_KEY && "gemini-3-flash-preview", process.env.OPENROUTER_API_KEY && "openrouter", "codex"].filter(Boolean).join(" -> "),
  });
});

app.get("/api/models", async (_req, res) => {
  const availability = await providerAvailability();
  const disabled = catalogPrefs.disabledSet();
  res.json({
    providers: availability,
    generated_at: registry.generated_at,
    catalog_sync: CATALOG_SYNC,
    formats: [
      ...Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label, custom: false })),
      ...customModes().map((m) => ({ id: m.id, label: m.label, custom: true, controls: m.controls })),
    ],
    models: registry.models.map((m) => ({
      ...m,
      // Explícito, nunca implícito: a mesma família de modelo existe por mais de
      // uma rota (gpt-image e gemini estão no fal E no Kling), com contas e
      // cobranças diferentes. Sem este campo, escolher a rota vira adivinhação.
      provider: providerOf(m),
      provider_label: PROVIDERS[providerOf(m)]?.label ?? providerOf(m),
      // Dois estados separados de proposito: um diz se DA para usar, o outro se
      // VOCE quer ver. Um modelo que sumiu precisa dizer por qual dos dois.
      available: availability[providerOf(m)]?.available !== false,
      unavailable_reason: availability[providerOf(m)]?.available === false
        ? availability[providerOf(m)].reason
        : null,
      unavailable_hint: availability[providerOf(m)]?.available === false
        ? availability[providerOf(m)].hint ?? null
        : null,
      enabled: !disabled.has(m.id),
      // "Gratis" NAO e propriedade do provedor: e o que a conta cobra hoje. A
      // Agnes pode passar a cobrar, o free tier do Gemini acaba (aconteceu:
      // RESOURCE_EXHAUSTED no meio desta sessao). Entao a classe de custo sai do
      // orcamento que o proprio adapter calcula, e nao de uma lista fixa na
      // interface — se a cobranca mudar, o adapter muda e a tela acompanha.
      cost_class: costClassOf(m),
      capabilities: capabilityById.get(m.id) ?? null,
      has_profile: Boolean(findProfile(m.id)),
      // live from fal, so a price change shows up without a code change
      pricing: LIVE_PRICES[m.id]
        ? { unit: LIVE_PRICES[m.id].unit, price: LIVE_PRICES[m.id].unit_price }
        : null,
    })),
  });
});

// Preferencia de catalogo: ligar/desligar modelos. Nada aqui afeta
// disponibilidade — um modelo ligado cuja chave sumiu continua indisponivel, e a
// tela diz isso, em vez de faze-lo desaparecer em silencio.
app.post("/api/catalog/enabled", (req, res) => {
  const { ids, enabled, only, reset } = req.body ?? {};
  const allIds = registry.models.map((m) => m.id);
  if (reset) return res.json({ disabled: catalogPrefs.reset() });
  if (Array.isArray(only)) return res.json({ disabled: catalogPrefs.keepOnly(only, allIds) });
  if (!ids) return res.status(400).json({ error: "Informe ids, only ou reset." });
  res.json({ disabled: catalogPrefs.setEnabled(ids, Boolean(enabled)) });
});

app.get("/api/providers", async (req, res) => {
  res.json({ providers: await providerAvailability({ force: req.query.refresh === "1" }) });
});

app.get("/api/capabilities", (_req, res) => {
  res.json({ ...CAPABILITIES, checks: store.capabilityChecks() });
});

app.get("/api/storage", (_req, res) => {
  res.json({
    engine: "SQLite",
    database: "data/bench.db",
    media_directory: "data/outputs",
    upload_directory: "data/inputs",
    ...store.storageSummary(),
  });
});

app.get("/api/projects", (req, res) => {
  const kind = ["website", "document"].includes(req.query.kind) ? req.query.kind : undefined;
  res.json({ rows: store.listProjects(kind).map(publicProject) });
});

app.get("/api/projects/:id", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json(publicProject(project));
});

// Arquivos de um projeto — visiveis mesmo quando a build falhou.
app.get("/api/projects/:id/files", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json({ files: projectFiles(project) });
});

// Um arquivo dentro do diretorio do projeto. `resolve` + prefixo garante que
// um nome como `../../.env` nao escape da pasta da build.
function projectFilePath(project, name) {
  const full = resolve(project.output_dir, String(name ?? ""));
  const root = resolve(project.output_dir);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

app.get("/api/projects/:id/file", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const full = projectFilePath(project, req.query.name);
  if (!full || !existsSync(full)) return res.status(404).json({ error: "File not found" });
  res.json({ name: req.query.name, content: readFileSync(full, "utf8") });
});

app.put("/api/projects/:id/file", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const { name, content } = req.body ?? {};
  const full = projectFilePath(project, name);
  if (!full) return res.status(400).json({ error: "Invalid file name" });
  if (typeof content !== "string") return res.status(400).json({ error: "content must be a string" });
  writeFileSync(full, content);
  res.json({ ok: true, name, size_bytes: Buffer.byteLength(content) });
});

app.get("/api/projects/:id/bundle", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project || project.kind !== "website" || project.status !== "complete") return res.status(404).json({ error: "Website bundle not found" });
  const files = ["index.html", "styles.css", "app.js"].filter((name) => existsSync(join(project.output_dir, name)));
  const payload = files.map((name) => ({ name, content: readFileSync(join(project.output_dir, name), "utf8") }));
  if (req.query.download === "1") {
    const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "website";
    res.attachment(`${slug}-source.zip`);
    res.type("application/zip");
    const archive = spawn("/usr/bin/zip", ["-q", "-j", "-", ...files], {
      cwd: project.output_dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    archive.on("error", (error) => {
      if (!res.headersSent) res.status(500).json({ error: `Could not package the website: ${error.message}` });
      else res.destroy(error);
    });
    archive.stdout.pipe(res);
    return;
  }
  res.json({
    project_id: project.id,
    title: project.title,
    files: payload,
  });
});

app.get("/api/project-engines", (_req, res) => {
  res.json({
    engines: Object.entries(ENGINES).map(([id, e]) => ({
      id, label: e.label, kind: e.kind, note: e.note,
      default_model: DEFAULT_ENGINE_MODEL[id] || null,
      available: id === "openrouter" ? Boolean(process.env.OPENROUTER_API_KEY) : true,
    })),
  });
});

app.post("/api/projects", (req, res) => {
  const { kind, title, prompt, template = kind === "website" ? "immersive" : "editorial-report", engine = "codex", model, reasoning = "low" } = req.body ?? {};
  if (!["website", "document"].includes(kind)) return res.status(400).json({ error: "kind must be website or document" });
  if (!String(title ?? "").trim()) return res.status(400).json({ error: "Give this project a title." });
  if (String(prompt ?? "").trim().length < 20) return res.status(400).json({ error: "Describe the audience, purpose, and desired look in a little more detail." });
  if (!ENGINES[engine]) return res.status(400).json({ error: `Motor desconhecido. Disponíveis: ${Object.keys(ENGINES).join(", ")}` });
  // A validação de modelo era `^gpt-` fixo, o que só faz sentido para o Codex.
  // Cada motor tem seu próprio vocabulário de nomes (qwen3.6:35b-a3b,
  // google/gemini-2.5-flash, claude-...), então validar contra o do Codex
  // rejeitaria modelos perfeitamente válidos dos outros.
  const chosenModel = String(model ?? "").trim() || DEFAULT_ENGINE_MODEL[engine] || "";
  if (engine === "codex" && !/^gpt-[a-zA-Z0-9._-]+$/.test(chosenModel)) {
    return res.status(400).json({ error: "Unsupported Codex model" });
  }
  if (chosenModel && !/^[a-zA-Z0-9._:\/-]{1,80}$/.test(chosenModel)) {
    return res.status(400).json({ error: "Nome de modelo inválido" });
  }
  if (!["low", "medium"].includes(reasoning)) return res.status(400).json({ error: "Reasoning must be low or medium" });
  if (projectProcesses.size >= 2) return res.status(429).json({ error: "Two creative builds are already running. Let one finish first." });
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const outputDir = join(PROJECTS, id);
  mkdirSync(outputDir, { recursive: true });
  const now = new Date().toISOString();
  const project = store.createProject({
    id, kind, title: String(title).trim(), prompt: String(prompt).trim(), template,
    status: "queued", stage: "Queued", progress: 0, output_dir: outputDir,
    model: chosenModel, reasoning, stages: [],
    // A tabela nao tem coluna `engine` e o INSERT e explicito — um campo solto
    // seria descartado em silencio. metadata_json ja e gravado e lido de volta.
    metadata: { engine_id: engine, engine: ENGINES[engine].label, kind: ENGINES[engine].kind },
    created_at: now, updated_at: now,
  });
  startProjectBuild(project);
  res.status(202).json(publicProject(store.getProject(id)));
});

// Revisar: um pedido em linguagem natural aplicado sobre os arquivos que ja
// existem, pelo mesmo motor que construiu (ou outro, se a pessoa preferir).
app.post("/api/projects/:id/revise", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (["queued", "running"].includes(project.status)) return res.status(409).json({ error: "Esta build ainda esta rodando." });
  const instruction = String(req.body?.instruction ?? "").trim();
  if (instruction.length < 4) return res.status(400).json({ error: "Diga o que mudar." });
  const engine = req.body?.engine || project.metadata?.engine_id || "codex";
  if (!ENGINES[engine]) return res.status(400).json({ error: `Motor desconhecido. Disponiveis: ${Object.keys(ENGINES).join(", ")}` });
  if (projectProcesses.size >= 2) return res.status(429).json({ error: "Duas builds ja estao rodando. Espere uma terminar." });

  const snapshot = snapshotProject(project);
  const updated = store.updateProject(project.id, {
    status: "queued", stage: "Revisao na fila", progress: 0, error: null,
    metadata: {
      ...(project.metadata ?? {}),
      engine_id: engine,
      engine: ENGINES[engine].label,
      mode: "revise",
      instruction,
      last_snapshot: snapshot.dir.split("/").at(-1),
    },
  });
  startProjectBuild(store.getProject(project.id));
  res.status(202).json(publicProject(store.getProject(project.id)));
});

// Voltar para o estado anterior a uma revisao.
app.post("/api/projects/:id/revert", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const snapshots = projectSnapshots(project);
  const target = req.body?.snapshot || snapshots[0]?.id;
  if (!target) return res.status(404).json({ error: "Nao ha versao anterior guardada." });
  const dir = join(project.output_dir, "history", String(target));
  if (!existsSync(dir)) return res.status(404).json({ error: "Versao nao encontrada." });
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) copyFileSync(join(dir, entry.name), join(project.output_dir, entry.name));
  }
  const updated = store.updateProject(project.id, { status: "complete", stage: "Revertido", progress: 100, error: null });
  res.json(publicProject(updated));
});

app.delete("/api/projects/:id", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  // Uma build em andamento tem processo vivo: matar antes, senao ele continua
  // escrevendo numa pasta que acabou de deixar de existir.
  const running = projectProcesses.get(project.id);
  if (running) { running.kill("SIGTERM"); projectProcesses.delete(project.id); }
  try { rmSync(project.output_dir, { recursive: true, force: true }); }
  catch (error) { console.warn(`falha ao apagar ${project.output_dir}: ${error.message}`); }
  store.deleteProject(project.id);
  res.json({ removed: true });
});

app.post("/api/projects/:id/cancel", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const child = projectProcesses.get(project.id);
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
  projectProcesses.delete(project.id);
  res.json(publicProject(store.updateProject(project.id, { status: "cancelled", stage: "Cancelled", error: null })));
});

app.get("/api/creative-references", async (_req, res) => {
  const refs = creativeReferences();
  const websiteUrl = refs.website_url;
  let websiteLive = false;
  if (websiteUrl) {
    try { websiteLive = (await fetch(websiteUrl, { signal: AbortSignal.timeout(800) })).ok; } catch {}
  }
  const documentPath = refs.document;
  const documentPdf = documentPath
    ? (documentPath.endsWith(".pdf") ? documentPath : documentPath.replace(/\.html$/, ".pdf"))
    : null;
  res.json({
    website: {
      name: refs.website ? refs.website.split("/").filter(Boolean).slice(-2).join("/") : "Local website reference",
      description: refs.website
        ? "The builder may inspect this for craft and interaction ideas. It is told not to copy brand, text, structure or assets."
        : "Point this at a site of yours whose finish you want matched. Nothing is copied from it.",
      path: refs.website,
      exists: Boolean(refs.website && existsSync(refs.website)),
      url: websiteUrl,
      preview_url: websiteLive ? websiteUrl : null,
    },
    document: {
      name: refs.document ? refs.document.split("/").at(-1) : "Local document reference",
      description: refs.document
        ? "The builder may inspect this for craft ideas. It is told not to copy its content."
        : "Point this at a document of yours whose finish you want matched.",
      path: refs.document,
      exists: Boolean(refs.document && existsSync(refs.document)),
      preview_url: documentPdf && existsSync(documentPdf) ? "/api/creative-references/document.pdf" : null,
    },
  });
});

app.get("/api/creative-references/document.pdf", (_req, res) => {
  const source = creativeReferences().document;
  const path = source ? (source.endsWith(".pdf") ? source : source.replace(/\.html$/, ".pdf")) : null;
  if (!path || !existsSync(path)) return res.status(404).json({ error: "Reference PDF is unavailable" });
  res.sendFile(resolve(path));
});

app.get("/api/tooling", (_req, res) => {
  res.json({
    name: "Bench Studio",
    transport: "stdio",
    command: MCP_NODE,
    args: [join(HERE, "mcp.mjs")],
    environment: { BENCH_URL: `http://localhost:${PORT}` },
    skill: {
      name: "bench-studio",
      version: "0.2.0",
      download_url: "/api/tooling/skill",
      installs: {
        codex: "~/.codex/skills/bench-studio",
        claude_code: "~/.claude/skills/bench-studio",
      },
    },
    tools: ["list_models", "get_model_capabilities", "upload_media", "create_media", "list_results", "get_usage", "sync_models", "create_website", "create_document", "list_projects", "get_project"],
  });
});

app.get("/api/tooling/skill", (_req, res) => {
  const folder = join(SKILL_PACKAGES, "bench-studio");
  if (!existsSync(join(folder, "SKILL.md"))) {
    return res.status(404).json({ error: "The Bench skill package is unavailable" });
  }

  res.attachment("bench-studio-skill.zip");
  res.type("application/zip");
  const archive = spawn("/usr/bin/zip", ["-q", "-r", "-", "bench-studio"], {
    cwd: SKILL_PACKAGES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let archiveError = "";
  archive.stderr.setEncoding("utf8");
  archive.stderr.on("data", (chunk) => { archiveError += chunk; });
  archive.on("error", (error) => {
    if (!res.headersSent) res.status(500).json({ error: `Could not package the skill: ${error.message}` });
    else res.destroy(error);
  });
  archive.on("close", (code) => {
    if (code !== 0 && !res.destroyed) res.destroy(new Error(archiveError || `zip exited with ${code}`));
  });
  archive.stdout.pipe(res);
});

app.get("/api/catalog/status", (_req, res) => {
  res.json(CATALOG_SYNC ?? {
    synced_at: null,
    production_models: registry.models.length,
    new_endpoint_count: null,
    status: catalogSyncPromise ? "syncing" : "not_synced",
  });
});

// ---------------------------------------------------------------- config
//
// Estado das variaveis de ambiente, SEM valor de segredo. O que sai daqui e
// "existe / veio de onde / termina em quanto" — nunca a chave.
app.get("/api/config", async (req, res) => {
  const estado = describeConfig();
  const disponibilidade = await providerAvailability().catch(() => ({}));
  res.json({
    ...estado,
    // Escrever e privilegio de quem esta NA maquina. Com --lan a interface fica
    // exposta para a rede inteira, e la ninguem troca chave de ninguem.
    writable: isLoopback(req),
    lan_exposed: (process.env.BENCH_WEB_HOST ?? "") !== "" && process.env.BENCH_WEB_HOST !== "127.0.0.1",
    providers: disponibilidade,
  });
});

app.post("/api/config", (req, res) => {
  if (!isLoopback(req)) {
    return res.status(403).json({ error: "Settings can only be changed from this machine. This request came from the network." });
  }
  const { error, patch } = validatePatch(req.body);
  if (error) return res.status(400).json({ error });
  if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to change." });

  // Caminho que nao existe e pior do que caminho vazio: a build passa a citar no
  // prompt um arquivo que o agente nao vai achar. Mesma regra de /api/settings.
  for (const campo of ["BENCH_WEBSITE_REFERENCE", "BENCH_DOCUMENT_REFERENCE"]) {
    if (patch[campo] && !existsSync(patch[campo])) return res.status(400).json({ error: `Does not exist: ${patch[campo]}` });
  }

  try {
    writeConfig(patch);
  } catch (e) {
    return res.status(500).json({ error: `Could not write .env: ${e.message}` });
  }

  // O processo NAO recarrega a chave sozinho: metade do servidor leu env no
  // boot (FAL_KEY, adapters, DATA). Dizer "salvo" sem dizer isto seria mentir.
  res.json({ ...describeConfig(), writable: true, restart_required: true });
});

// Testa de verdade contra o provedor, com a chave que esta valendo AGORA no
// processo — nao a que acabou de ser gravada. E por isso que a resposta pode
// dizer "falhou" logo depois de um salvo bem-sucedido: o processo ainda usa a
// antiga, e e util saber disso em vez de descobrir na hora de gerar.
app.post("/api/config/test/:provider", async (req, res) => {
  const alvo = String(req.params.provider ?? "");
  const provider = PROVIDERS[alvo];
  if (!provider) return res.status(404).json({ error: `Unknown provider: ${alvo}` });
  try {
    const estado = await providerAvailability({ force: true });
    res.json({ provider: alvo, ...(estado?.[alvo] ?? { available: false, reason: "No answer" }) });
  } catch (e) {
    res.status(500).json({ provider: alvo, available: false, reason: e.message });
  }
});

// Definir e remover senha seguem a MESMA regra das chaves: so da propria
// maquina. Numa VPS, use `npm run set-password` ou um tunel SSH — e de proposito
// que trocar a tranca exija estar do lado de dentro dela.
app.post("/api/config/password", (req, res) => {
  if (!isLoopback(req)) {
    return res.status(403).json({ error: "The password can only be changed from this machine." });
  }
  const nova = String(req.body?.password ?? "");
  try {
    if (nova === "") {
      writeConfig({ BENCH_PASSWORD: "" });
      auth.setHash("");
      return res.json({ ok: true, required: false, message: "Password removed. The studio is open again." });
    }
    const hash = hashPassword(nova);
    writeConfig({ BENCH_PASSWORD: hash });
    // Vale JA, sem esperar restart: a janela entre "defini a senha" e "ela
    // funciona" e exatamente quando o estudio esta exposto.
    auth.setHash(hash);
    res.json({ ok: true, required: true, message: "Password set. Everyone else was signed out." });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/settings", (_req, res) => res.json(readSettings()));

app.post("/api/settings", (req, res) => {
  const patch = {};
  for (const campo of ["website_reference", "document_reference"]) {
    if (req.body?.[campo] === undefined) continue;
    const valor = String(req.body[campo] ?? "").trim();
    // Caminho que nao existe e pior que caminho vazio: a build passa a citar no
    // prompt um arquivo que o agente nao vai achar, e ninguem descobre por que
    // o resultado nao melhorou.
    if (valor && !existsSync(valor)) return res.status(400).json({ error: `Nao existe: ${valor}` });
    patch[campo] = valor;
  }
  if (req.body?.website_reference_url !== undefined) {
    patch.website_reference_url = String(req.body.website_reference_url ?? "").trim();
  }
  if (req.body?.catalog_refresh_hours !== undefined) {
    const hours = Number(req.body.catalog_refresh_hours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 7) {
      return res.status(400).json({ error: "Intervalo invalido (0 = so manual, ate 168h)." });
    }
    patch.catalog_refresh_hours = hours;
  }
  res.json(writeSettings(patch));
});

// Atualizacao FORCADA e completa: descobrir endpoints novos, repuxar precos ao
// vivo e reconferir disponibilidade dos provedores. Sao tres coisas distintas
// que antes so aconteciam em momentos diferentes (sync a cada 6h, precos so no
// boot, disponibilidade com cache de 1 min) — e nenhuma delas dava para pedir.
app.post("/api/catalog/refresh", async (_req, res) => {
  const resultado = { started_at: new Date().toISOString() };
  const [discovery, prices, availability] = await Promise.allSettled([
    refreshCatalogDiscovery(),
    fetchLivePrices(falModels().map((m) => m.id)).then((p) => { LIVE_PRICES = p; return Object.keys(p).length; }),
    providerAvailability({ force: true }),
  ]);
  resultado.discovery = discovery.status === "fulfilled"
    ? { ok: true, relevant: discovery.value?.relevant_active_endpoints ?? null, new: discovery.value?.new_endpoint_count ?? null }
    : { ok: false, error: String(discovery.reason?.message ?? discovery.reason).slice(0, 200) };
  resultado.pricing = prices.status === "fulfilled"
    ? { ok: true, priced: prices.value, of: falModels().length }
    : { ok: false, error: String(prices.reason?.message ?? prices.reason).slice(0, 200) };
  resultado.providers = availability.status === "fulfilled" ? availability.value : { error: "falhou" };
  res.json(resultado);
});

app.post("/api/catalog/sync", async (_req, res) => {
  try { res.json(await refreshCatalogDiscovery()); }
  catch (error) { res.status(502).json({ error: String(error.message ?? error) }); }
});

app.get("/api/spend", (_req, res) => res.json(spendSummary()));

app.get("/api/fal/billing", async (req, res) => {
  const billing = await fetchFalBilling({ force: req.query.refresh === "1" });
  const { fetched_at_ms: _privateTimestamp, ...publicBilling } = billing;
  res.json(publicBilling);
});

// What will this cost, before I press go.
app.post("/api/quote", (req, res) => {
  const { modelId, params = {} } = req.body ?? {};
  if (!byId.has(modelId)) return res.status(400).json({ error: `unknown model ${modelId}` });
  // Pelo adapter, não por estimateCost: este último só sabe consultar a tabela
  // de preços do fal, e responderia "no pricing available" para um provider
  // gratuito — o oposto do que o ledger precisa mostrar.
  res.json(adapterFor(byId.get(modelId)).quote(modelId, params));
});

app.get("/api/ledger", (_req, res) => {
  // SQLite already returns newest first. Reversing this made the Results tab
  // and ledger lead with the oldest work, burying the generation just made.
  const rows = readLedger().slice(0, 200);
  res.json({ rows, summary: spendSummary() });
});

app.delete("/api/results/:id", (req, res) => {
  const removed = store.deleteGeneration(req.params.id);
  if (!removed) return res.status(404).json({ error: "Result not found" });

  const deletedFiles = [];
  const outputRoot = `${resolve(OUTPUTS)}/`;
  for (const asset of removed.assets) {
    const localPath = asset.local_path ? resolve(asset.local_path) : null;
    if (!localPath || !localPath.startsWith(outputRoot)) continue;
    try {
      if (existsSync(localPath)) {
        unlinkSync(localPath);
        deletedFiles.push(basename(localPath));
      }
    } catch (error) {
      console.warn(`could not delete local result ${basename(localPath)}: ${error.message}`);
    }

    const stem = basename(localPath, extname(localPath));
    for (const extension of [".jpg", ".jpeg", ".png", ".webp"]) {
      const previewPath = resolve(PREVIEWS, `${stem}${extension}`);
      if (!previewPath.startsWith(`${resolve(PREVIEWS)}/`)) continue;
      try {
        if (existsSync(previewPath)) {
          unlinkSync(previewPath);
          deletedFiles.push(basename(previewPath));
        }
      } catch (error) {
        console.warn(`could not delete result preview ${basename(previewPath)}: ${error.message}`);
      }
    }
  }

  res.json({
    ok: true,
    archive_id: removed.archive_id,
    deleted_files: deletedFiles.length,
    remote_copy_retained: true,
    summary: spendSummary(),
    storage: store.storageSummary(),
  });
});

// ---------------------------------------------------------------- modos
// Os modos de fabrica continuam em codigo; estes sao os que a pessoa cria.
app.get("/api/modes", (_req, res) => {
  res.json({
    builtin: Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label, brief: f.brief, custom: false })),
    custom: customModes(),
  });
});

app.post("/api/modes", (req, res) => {
  try { res.json(modesStore.save(req.body ?? {})); }
  catch (error) { res.status(400).json({ error: String(error.message ?? error) }); }
});

app.delete("/api/modes/:id", (req, res) => {
  res.json({ removed: modesStore.remove(req.params.id) });
});

app.post("/api/reload", (_req, res) => { reloadKnowledge(); res.json({ ok: true, profiles: Object.keys(PROFILES).length }); });

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const local = localUploadCopy(req.file);
    const url = await falUpload(req.file.buffer, req.file.originalname, req.file.mimetype);
    const record = { ...local, remote_url: url };
    store.recordUpload(record);
    res.json({
      url,
      remote_url: url,
      local_url: local.local_url,
      upload_id: local.upload_id,
      media_type: local.media_type,
      content_type: local.content_type,
      size_bytes: local.size_bytes,
      name: local.original_name,
    });
  } catch (e) {
    console.warn(`fal upload failed: ${String(e.message ?? e)}`);
    res.status(502).json({ error: publicProviderError(e, "upload") });
  }
});

app.post("/api/optimize", async (req, res) => {
  try {
    const { idea, modelId, format = "none", hasReference = false, refCount = 0, params = {}, shotSettings = {} } = req.body ?? {};
    if (!idea || !modelId) return res.status(400).json({ error: "idea and modelId required" });
    const model = byId.get(modelId);
    if ((hasReference || refCount > 0) && model && !imageInputForModel(model)) {
      const pair = model.pair ? byId.get(model.pair) : null;
      return res.status(400).json({
        error: pair
          ? `${model.label} cannot use a reference image. Use ${pair.label} for this reference instead.`
          : `${model.label} does not accept reference images. Choose an image-capable model.`,
      });
    }
    res.json(await optimizePrompt({
      idea, modelId, format, params,
      shotSettings,
      hasReference: hasReference || refCount > 0,
      refCount: refCount || (hasReference ? 1 : 0),
    }));
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

// The main event. Streams progress back as newline-delimited JSON so the UI can
// show queue position instead of a dead spinner.
app.post("/api/generate", async (req, res) => {
  const { modelId, prompt, params = {}, referenceUrls = [], inputAssets = [], format = "none", rawIdea = null, shotSettings = {} } = req.body ?? {};
  const model = byId.get(modelId);
  if (!model) return res.status(400).json({ error: `unknown model ${modelId}` });
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  // Indisponivel e DESLIGADO merecem tratamentos opostos.
  //
  // Sem chave, a geracao falharia de qualquer jeito — melhor falhar aqui,
  // dizendo o que falta, do que la na frente com um erro do provedor.
  //
  // Desligado e so preferencia: some das listas, mas continua gerando se for
  // pedido de proposito. Bloquear quebraria o Redo de um resultado antigo cujo
  // modelo voce desligou depois — e quem pediu explicitamente sabe o que quer.
  const providerStatus = (await providerAvailability())[providerOf(model)];
  if (providerStatus && providerStatus.available === false) {
    return res.status(400).json({
      error: `${model.label} nao esta disponivel: ${providerStatus.reason}.${providerStatus.hint ? ` ${providerStatus.hint}` : ""}`,
    });
  }

  // Never let a reference silently disappear. The client normally switches to
  // the paired image-capable endpoint, but this guard protects direct callers
  // and catches UI races before they become a paid generation.
  const imageInput = imageInputForModel(model);
  const capability = capabilityById.get(modelId);
  const inputSpecs = new Map((capability?.inputs ?? []).map((spec) => [spec.field, spec]));
  const normalizedAssets = inputAssets.length
    ? inputAssets
    : referenceUrls.map((url) => ({ url, field: imageInput?.name, media_type: "image" }));
  if (referenceUrls.length && !imageInput) {
    const pair = model.pair ? byId.get(model.pair) : null;
    return res.status(400).json({
      error: pair
        ? `${model.label} cannot use a reference image. Use ${pair.label} for this reference instead.`
        : `${model.label} does not accept reference images. Choose an image-capable model.`,
    });
  }
  for (const asset of normalizedAssets) {
    const spec = inputSpecs.get(asset.field);
    if (!asset.url || !asset.field || !spec) {
      return res.status(400).json({ error: `${model.label} cannot use the attached ${asset.media_type ?? "media"} in that input slot.` });
    }
    if (asset.media_type && spec.modality !== "mixed" && asset.media_type !== spec.modality) {
      return res.status(400).json({ error: `${asset.field} accepts ${spec.modality}, not ${asset.media_type}.` });
    }
  }
  for (const spec of inputSpecs.values()) {
    const count = normalizedAssets.filter((asset) => asset.field === spec.field).length;
    if (spec.arity === "single" && count > 1) {
      return res.status(400).json({ error: `${model.label} accepts one file in ${spec.field}. Remove ${count - 1} and try again.` });
    }
    if (spec.limits?.max_items && spec.arity === "multiple" && count > spec.limits.max_items) {
      return res.status(400).json({ error: `${model.label} accepts up to ${spec.limits.max_items} files in ${spec.field}.` });
    }
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  const send = (o) => res.write(JSON.stringify(o) + "\n");

  try {
    // Precisa vir antes de resolver os anexos: e o adapter que diz se aquele
    // provedor aceita data URI, caminho local ou so URL publica.
    const adapter = adapterFor(model);
    const directionLines = shotDirectionLines(shotSettings);
    const promptWithDirection = directionLines.length && format !== "none"
      ? `${prompt}\n\nCreative direction: ${directionLines.join("; ")}.`
      : prompt;
    const input = { prompt: promptWithDirection, ...params };

    // Several endpoints will "expand" your prompt server-side. The prompt we
    // just wrote follows that model's own documented rules, so letting the
    // vendor paraphrase it throws the research away. Off unless asked.
    if ("enable_prompt_expansion" in (model.params ?? {}) &&
        params.enable_prompt_expansion === undefined) {
      input.enable_prompt_expansion = false;
    }
    for (const spec of inputSpecs.values()) {
      const values = [];
      for (const asset of normalizedAssets.filter((item) => item.field === spec.field)) {
        values.push(await resolveAssetForProvider(asset.url, adapter));
      }
      if (values.length) input[spec.field] = spec.arity === "multiple" ? values : values[0];
    }
    // never submit empty-string params, fal validates strictly
    for (const k of Object.keys(input)) {
      if (input[k] === "" || input[k] === null || input[k] === undefined) delete input[k];
    }

    const pre = adapter.quote(modelId, input);
    send({ phase: "submitting", input, estimate: pre, provider: providerOf(model) });
    const q = await adapter.submit(modelId, input);
    for (const field of new Set(normalizedAssets.map((asset) => asset.field))) {
      store.recordCapabilityCheck({
        model_id: modelId,
        input_field: field,
        status: "submission-verified",
        source: "runtime",
        evidence: "fal accepted a real queued request containing this input field.",
        details: { request_id: q.request_id },
        verified_at: new Date().toISOString(),
      });
    }
    send({ phase: "queued", request_id: q.request_id });

    const { result, billableUnits } = await adapter.poll(modelId, q, {
      onUpdate: (s) => send({ phase: "status", status: s.status, queue_position: s.queue_position ?? null }),
    });

    // Prefer what the provider actually billed. Fall back to the estimate when
    // it does not report a billed quantity.
    const priced = adapter.actual(modelId, billableUnits) ?? pre;
    const { cost, confidence, basis } = priced;
    const outputs = await mirrorOutputs(extractUrls(result), q.request_id);
    const row = {
      ts: new Date().toISOString(),
      model: modelId,
      label: model.label,
      // Which backend actually ran and billed this. The same model can exist on
      // more than one route (fal vs direct), so the receipt has to say which.
      provider: providerOf(model),
      vendor: model.vendor,
      kind: model.kind,
      lane: model.lane,
      format,
      raw_idea: rawIdea,
      prompt: promptWithDirection,
      reference_count: normalizedAssets.length,
      reference_mode: normalizedAssets.length ? normalizedAssets.map((asset) => asset.field).join(",") : null,
      input_assets: normalizedAssets,
      params: input,
      request_id: q.request_id,
      cost,
      cost_confidence: confidence,
      cost_basis: basis,
      billable_units: billableUnits,
      estimated_cost: pre.cost,
      outputs,
    };
    appendLedger(row);

    send({ phase: "done", result, ledger: row, spend: spendSummary() });
    res.end();
  } catch (e) {
    console.warn(`generation failed: ${String(e.message ?? e)}`);
    send({ phase: "error", error: publicProviderError(e, "generation") });
    res.end();
  }
});

function extractUrls(result) {
  const urls = [];
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v.url === "string") urls.push({
      url: v.url,
      content_type: v.content_type ?? null,
      width: v.width ?? null,
      height: v.height ?? null,
      // Provider local já entrega o arquivo gravado. Sem carregar isto adiante,
      // mirrorOutputs trataria a saída como remota e tentaria baixá-la.
      ...(v.local_path ? { local_path: v.local_path, local_url: v.local_url ?? null } : {}),
    });
    Object.values(v).forEach(walk);
  };
  walk(result);
  return urls;
}

const PORT = process.env.PORT || 8787;
// The API binds to loopback. The interface is what gets published (see
// `scripts/remote.sh`); this process answers the interface, and the interface
// runs on the same machine. Binding it to every NIC by default would put the
// endpoint that writes files and spends money on the network without anyone
// asking for it. BENCH_API_HOST=0.0.0.0 is the deliberate opt-out.
const HOST = process.env.BENCH_API_HOST || "127.0.0.1";

// Start serving immediately. Price discovery is useful, but it should never
// make the whole studio look offline while fal is slow or rate-limiting us.
LIVE_PRICES = readPriceCache();
const cachedPriced = Object.keys(LIVE_PRICES).length;

app.listen(PORT, HOST, () => {
  const s = spendSummary();
  console.log(`studio server on http://localhost:${PORT} (bound to ${HOST})`);
  console.log(`  ${registry.models.length} models, ${Object.keys(PROFILES).length} prompt profiles`);
  console.log(`  API-derived image inputs: ${registry.models.filter((model) => imageInputForModel(model)).length}/${registry.models.length}`);
  console.log(`  cached prices: ${cachedPriced}/${falModels().length} fal models; refreshing in background`);
  const byProvider = registry.models.reduce((acc, m) => { const p = providerOf(m); acc[p] = (acc[p] ?? 0) + 1; return acc; }, {});
  console.log(`  providers: ${Object.entries(byProvider).map(([p, n]) => `${p}=${n}`).join(", ")}`);
  console.log(`  spend: $${s.all_time} all time, $${s.month} this month, ${s.total_generations} generations`);
});

fetchLivePrices(falModels().map((m) => m.id))
  .then((prices) => {
    LIVE_PRICES = prices;
    console.log(`pricing refresh complete: ${Object.keys(LIVE_PRICES).length}/${falModels().length} fal models`);
  })
  .catch((e) => console.warn(`pricing refresh failed: ${e.message}`));

// Discovery is deliberately independent of serving and generation. A fal
// outage cannot take the studio down, and an unvalidated endpoint can never
// silently replace a working production model.
refreshCatalogDiscovery().catch((error) => console.warn(`catalog sync failed: ${error.message}`));
backfillMediaMirrors().catch((error) => console.warn(`media backfill failed: ${error.message}`));
scheduleCatalogRefresh(readSettings().catalog_refresh_hours);
