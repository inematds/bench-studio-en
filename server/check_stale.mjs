// check_stale.mjs — is anything in the roster out of date?
//
//   node check_stale.mjs
//
// Pulls fal's live catalog and, for every model in the registry, lists the
// other endpoints in the same family. Version numbers move fast enough that a
// roster hand-written two months ago is already wrong, which is exactly how you
// end up demoing GPT Image 1 while GPT Image 2 is shipping.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(readFileSync(join(HERE, "registry.json"), "utf8"));

const CATEGORIES = ["text-to-image", "image-to-image", "text-to-video", "image-to-video"];

// Same alias groups the server uses, so "minimax", "hailuo" and "h3" count as
// one family rather than three.
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

// Variants we never want in a concepting roster: LoRA plumbing, tiny distills,
// utility endpoints. These are not "newer", they are different jobs.
const NOISE = /lora|klein|\/base|control|inpaint|outpaint|erase|fill|vectorize|upscale|reframe|transparent|layerize|utility|virtual-try-on|lipsync|avatar|effects|preview|-lite$|\/lite$/i;

async function fetchCategory(cat) {
  const out = [];
  for (const offset of [0, 100]) {
    const r = await fetch(`https://fal.ai/api/models?categories=${cat}&limit=100&offset=${offset}`);
    if (!r.ok) break;
    const j = await r.json();
    const items = j.items ?? [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

const live = new Map();
for (const c of CATEGORIES) {
  for (const i of await fetchCategory(c)) {
    live.set(`${i.id}|${i.category}`, { id: i.id, title: i.title, category: i.category });
  }
  process.stdout.write(".");
}
process.stdout.write("\n");

const inRoster = new Set(registry.models.map((m) => m.id));

function liveCat(lane) {
  return {
    t2i: "text-to-image", i2i: "image-to-image",
    t2v: "text-to-video", i2v: "image-to-video", r2v: "image-to-video",
  }[lane];
}

console.log(`\nRoster: ${registry.models.length} models. Live catalog: ${live.size} endpoints.\n`);
console.log("Sibling endpoints in the same family that are NOT in the roster.");
console.log("Version ordering is not machine-decidable here, so this is a list to read,");
console.log("not a verdict. Anything obviously newer, put it in ROSTER and rebuild.\n");

// group the roster by family + lane so each family prints once
const seen = new Set();
for (const m of registry.models) {
  const fam = familyOf(m.id);
  if (!fam) continue;
  const key = `${fam}|${m.lane}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const cat = liveCat(m.lane);
  const mine = registry.models.filter((x) => familyOf(x.id) === fam && x.lane === m.lane);
  const others = [...live.values()]
    .filter((x) => x.category === cat && familyOf(x.id) === fam)
    .filter((x) => !inRoster.has(x.id))
    .filter((x) => !NOISE.test(x.id))
    .map((x) => x.id)
    .sort();

  if (!others.length) continue;

  console.log(`${fam.toUpperCase()} · ${cat}`);
  console.log(`  in roster : ${mine.map((x) => x.id).join(", ")}`);
  for (const o of others) console.log(`  also live : ${o}`);
  console.log();
}
