// registry_merge.mjs — junta os modelos de providers não-fal ao registry.
//
// `registry.json` é REGENERADO por `npm run registry` a partir dos schemas
// OpenAPI que o fal publica. Provider que não é fal não tem OpenAPI: suas
// entradas seriam apagadas a cada rebuild. Por isso cada provider traz seus
// modelos em `providers/<nome>.models.json`, escritos à mão, e a junção
// acontece no load — nunca no arquivo gerado.
//
// Usado pelo server e pelo builder de capabilities, para que os dois enxerguem
// exatamente o mesmo conjunto de modelos.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function mergeProviderModels(registry, { warn = console.warn } = {}) {
  if (!existsSync(HERE)) return registry;
  for (const file of readdirSync(HERE).filter((f) => f.endsWith(".models.json")).sort()) {
    try {
      const extra = JSON.parse(readFileSync(join(HERE, file), "utf8"));
      const known = new Set(registry.models.map((m) => m.id));
      for (const model of extra.models ?? []) {
        if (known.has(model.id)) { warn(`${file}: ${model.id} já existe no registry, ignorado`); continue; }
        registry.models.push(model);
        known.add(model.id);
      }
    } catch (error) { warn(`provider models ${file}: ${error.message}`); }
  }
  return registry;
}

export default mergeProviderModels;
