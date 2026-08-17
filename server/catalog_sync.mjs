import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const API = "https://api.fal.ai/v1/models";
const RELEVANT = new Map([
  ["text-to-image", { kind: "image", lane: "t2i", label: "Text to image" }],
  ["image-to-image", { kind: "image", lane: "i2i", label: "Image editing" }],
  ["text-to-video", { kind: "video", lane: "t2v", label: "Text to video" }],
  ["image-to-video", { kind: "video", lane: "i2v", label: "Image to video" }],
  ["reference-to-video", { kind: "video", lane: "r2v", label: "Reference video" }],
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readCatalogSync(cachePath) {
  if (!existsSync(cachePath)) return null;
  try { return JSON.parse(readFileSync(cachePath, "utf8")); }
  catch { return null; }
}

async function falGet(url, key) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      headers: key ? { Authorization: `Key ${key}` } : {},
    });
    if (response.status === 429) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!response.ok) throw new Error(`fal catalog HTTP ${response.status}`);
    return response.json();
  }
  throw new Error("fal catalog rate limit did not clear");
}

async function fetchCategory(category, key) {
  const models = [];
  let cursor = null;
  do {
    const url = new URL(API);
    url.searchParams.set("limit", "50");
    url.searchParams.set("status", "active");
    url.searchParams.set("category", category);
    if (cursor) url.searchParams.set("cursor", cursor);
    const page = await falGet(url, key);
    models.push(...(page.models ?? []));
    cursor = page.next_cursor || null;
  } while (cursor);
  return models;
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function candidate(model) {
  const metadata = model.metadata ?? {};
  const type = RELEVANT.get(metadata.category);
  return {
    id: model.endpoint_id,
    label: metadata.display_name || model.endpoint_id.split("/").at(-1),
    category: metadata.category,
    category_label: type?.label ?? metadata.category,
    kind: type?.kind ?? null,
    lane: type?.lane ?? null,
    description: String(metadata.description ?? "").trim(),
    thumbnail: metadata.thumbnail_url ?? null,
    date: metadata.date ?? null,
    updated_at: metadata.updated_at ?? null,
    highlighted: Boolean(metadata.highlighted),
    pinned: Boolean(metadata.pinned),
    tags: metadata.tags ?? [],
    model_url: metadata.model_url ?? `https://fal.ai/models/${model.endpoint_id}`,
  };
}

function candidateRank(item) {
  return (item.pinned ? 4e15 : 0) + (item.highlighted ? 2e15 : 0) +
    Math.max(timestamp(item.date), timestamp(item.updated_at));
}

export async function syncFalCatalog({ key, registry, cachePath }) {
  const currentIds = new Set(registry.models.map((model) => model.id));
  const pages = await Promise.all(
    [...RELEVANT.keys()].map(async (category) => {
      try { return await fetchCategory(category, key); }
      catch (error) { return { category, error: String(error.message ?? error) }; }
    })
  );

  const errors = pages.filter((page) => !Array.isArray(page));
  const active = pages.flatMap((page) => Array.isArray(page) ? page : []);
  if (!active.length && errors.length) throw new Error(errors.map((item) => item.error).join("; "));

  const allDiscovered = active
    .map(candidate)
    .filter((item) => !currentIds.has(item.id))
    .sort((a, b) => candidateRank(b) - candidateRank(a));
  const recentCutoff = Date.now() - 120 * 24 * 60 * 60 * 1000;
  const allCandidates = allDiscovered.filter((item) =>
    item.pinned || item.highlighted || timestamp(item.date) >= recentCutoff
  );

  const newestByCategory = {};
  for (const category of RELEVANT.keys()) {
    newestByCategory[category] = allCandidates
      .filter((item) => item.category === category)
      .slice(0, 8);
  }

  const activeIds = new Set(active.map((model) => model.endpoint_id));
  const result = {
    synced_at: new Date().toISOString(),
    source: "fal Platform Model Search API",
    source_url: "https://api.fal.ai/v1/models",
    refresh_hours: 6,
    production_models: registry.models.length,
    relevant_active_endpoints: active.length,
    endpoints_outside_roster: allDiscovered.length,
    new_endpoint_count: allCandidates.length,
    highlighted_new_count: allCandidates.filter((item) => item.highlighted || item.pinned).length,
    roster_missing_from_active_search: registry.models
      .filter((model) => RELEVANT.has(model.category) && !activeIds.has(model.id))
      .map((model) => ({ id: model.id, label: model.label, category: model.category })),
    newest: allCandidates.slice(0, 24),
    newest_by_category: newestByCategory,
    errors,
    policy: "New or highlighted endpoints from the last 120 days are discovered automatically. They enter the production picker only after their schema, pricing, reference inputs, and prompt behavior are validated.",
  };

  const tempPath = `${cachePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(result, null, 2));
  renameSync(tempPath, cachePath);
  return result;
}
