// catalog_prefs.mjs — quais modelos VOCÊ quer ver.
//
// Separado de disponibilidade de propósito. Disponibilidade é fato (a chave
// existe, o serviço responde) e é calculada toda vez. Isto aqui é preferência, e
// é a única coisa que vale a pena persistir.
//
// Guarda apenas as EXCEÇÕES — os ids que você desligou. Assim:
//   - o padrão é "tudo que está disponível aparece", entao quem acabou de clonar
//     abre o estúdio funcionando em vez de um catálogo vazio que parece quebrado;
//   - modelo novo que entrar no registry aparece sozinho, sem precisar ser
//     religado um por um;
//   - apagar este arquivo devolve o estúdio ao estado de fábrica.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE_NAME = "catalog-prefs.json";

export function createCatalogPrefs({ dataDir }) {
  const path = join(dataDir, FILE_NAME);

  function read() {
    if (!existsSync(path)) return { disabled: [] };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return { disabled: Array.isArray(parsed?.disabled) ? parsed.disabled : [] };
    } catch (error) {
      console.warn(`catalog-prefs.json ilegível (${error.message}); tratando como vazio`);
      return { disabled: [] };
    }
  }

  function write(state) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ disabled: [...new Set(state.disabled)].sort() }, null, 2));
  }

  return {
    disabledSet: () => new Set(read().disabled),

    setEnabled(ids, enabled) {
      const list = Array.isArray(ids) ? ids : [ids];
      const disabled = new Set(read().disabled);
      for (const id of list) {
        if (enabled) disabled.delete(id);
        else disabled.add(id);
      }
      write({ disabled: [...disabled] });
      return [...disabled];
    },

    // Ligar exatamente um conjunto e desligar o resto. É o que os atalhos
    // ("só os gratuitos", "só os locais") precisam para não virar 70 cliques.
    keepOnly(ids, allIds) {
      const keep = new Set(ids);
      write({ disabled: allIds.filter((id) => !keep.has(id)) });
      return allIds.filter((id) => !keep.has(id));
    },

    reset() {
      write({ disabled: [] });
      return [];
    },
  };
}

export default createCatalogPrefs;
