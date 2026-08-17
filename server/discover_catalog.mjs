import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { syncFalCatalog } from "./catalog_sync.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const dataDir = join(HERE, "..", "data");
mkdirSync(dataDir, { recursive: true });

const envPath = join(homedir(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[name]) process.env[name] = value;
  }
}

const registry = JSON.parse(readFileSync(join(HERE, "registry.json"), "utf8"));
const result = await syncFalCatalog({
  key: process.env.FAL_KEY,
  registry,
  cachePath: join(dataDir, "catalog-sync.json"),
});

console.log(`fal catalog synced at ${result.synced_at}`);
console.log(`${result.production_models} production models`);
console.log(`${result.relevant_active_endpoints} relevant active endpoints on fal`);
console.log(`${result.new_endpoint_count} endpoints awaiting validation`);
if (result.roster_missing_from_active_search.length) {
  console.warn("Production endpoints missing from active search:");
  for (const model of result.roster_missing_from_active_search) console.warn(`- ${model.id}`);
}
