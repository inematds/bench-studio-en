import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mergeProviderModels } from "./providers/registry_merge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function readProfiles(dir) {
  const profiles = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || file === "pricing.json") continue;
    try { Object.assign(profiles, JSON.parse(readFileSync(join(dir, file), "utf8"))); }
    catch (error) { console.warn(`Skipping ${file}: ${error.message}`); }
  }
  return profiles;
}

function findNumber(description, patterns) {
  for (const pattern of patterns) {
    const match = String(description ?? "").match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function inferredLimits(input) {
  const text = input.description ?? "";
  return {
    min_items: input.min_items ?? null,
    max_items: input.max_items ?? findNumber(text, [
      /up to\s+(\d+)\s+(?:images?|videos?|audio files?|files?|references?|elements?)/i,
      /max(?:imum)?\s+(?:of\s+)?(\d+)\s+(?:images?|videos?|audio files?|files?|references?|elements?)/i,
    ]),
    max_megabytes: findNumber(text, [/max(?:imum)?\s+(\d+)\s*mb/i, /under\s+(\d+)\s*mb/i]),
    min_seconds: findNumber(text, [/(\d+)\s*(?:-|to)\s*\d+\s*seconds/i]),
    max_seconds: findNumber(text, [/(?:-|to)\s*(\d+)\s*seconds/i, /max(?:imum)?\s+(\d+)\s*seconds/i]),
  };
}

function profileEvidence(profile) {
  if (!profile) return null;
  const queue = [profile];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    for (const [key, nested] of Object.entries(value)) {
      if (/reference_image_behavior|input_requirements|media_inputs/i.test(key) && typeof nested === "string") {
        return nested.slice(0, 900);
      }
      if (nested && typeof nested === "object") queue.push(nested);
    }
  }
  return null;
}

export function buildCapabilityManifest(registry, profiles = {}) {
  const models = registry.models.map((model) => {
    const inputs = (model.media_inputs ?? []).map((input) => ({
      field: input.name,
      modality: input.modality,
      role: input.role,
      arity: input.arity,
      required: Boolean(input.required),
      description: input.description ?? "",
      accepted_type: input.type,
      item_type: input.items?.type ?? null,
      limits: inferredLimits(input),
      provenance: [{ source: "fal-openapi", status: "schema-supported", checked_at: registry.generated_at }],
    }));
    const modalities = [...new Set(inputs.map((input) => input.modality))];
    return {
      model_id: model.id,
      label: model.label,
      vendor: model.vendor,
      output: model.kind,
      lane: model.lane,
      inputs,
      modalities,
      primary_image_field: model.image_input?.name ?? null,
      image_arity: model.image_input?.arity ?? null,
      prompt_profile: Boolean(profiles[model.id]),
      researched_input_evidence: profileEvidence(profiles[model.id]),
      confidence: inputs.length ? "schema-supported" : "schema-reports-no-media-input",
    };
  });
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    schema_generated_at: registry.generated_at,
    source: registry.source,
    status_legend: {
      "schema-supported": "Declared by fal's live OpenAPI schema; not necessarily exercised.",
      "submission-verified": "A real request containing this field was accepted.",
      "output-verified": "A generated result was manually or automatically checked against the input.",
      failed: "A real request containing this field was rejected.",
      untested: "No current evidence exists.",
    },
    models,
  };
}

export function loadOrBuildCapabilityManifest({ registry, profiles, path }) {
  if (existsSync(path)) {
    try {
      const current = JSON.parse(readFileSync(path, "utf8"));
      // generated_at só reflete o schema do fal. Modelos escritos à mão por
      // provider entram sem mexer nele, então o total também precisa bater —
      // senão um manifesto velho esconde o provider novo e a validação de
      // anexos rejeita tudo que ele aceita.
      if (current.schema_generated_at === registry.generated_at
          && current.models?.length === registry.models.length) return current;
    } catch {}
  }
  const manifest = buildCapabilityManifest(registry, profiles);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return manifest;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const registry = mergeProviderModels(JSON.parse(readFileSync(join(HERE, "registry.json"), "utf8")));
  const profiles = readProfiles(join(HERE, "profiles"));
  const manifest = buildCapabilityManifest(registry, profiles);
  writeFileSync(join(HERE, "capabilities.json"), JSON.stringify(manifest, null, 2));
  console.log(`wrote capabilities.json: ${manifest.models.length} models`);
}
