// modes_store.mjs — modos personalizados, criados pela interface.
//
// Os modos de fábrica (Freeform, UGC, Unboxing, Hyper Motion, TV Spot, Product
// Still, Ad with Headline) vivem em `FORMATS`, no server.mjs, e os submodos em
// `SHOT_DIRECTION`, no PromptBar.jsx. São código: mudar exige editar arquivo e
// reiniciar. Isso é aceitável para quem escreveu o projeto e inútil para quem só
// quer trabalhar nele.
//
// Este arquivo guarda os modos que o usuário cria pela aba Modes. Eles são
// aditivos: nunca sobrescrevem os de fábrica, e sumir com este JSON só devolve o
// estúdio ao estado original.
//
// Um modo é: um `brief` que entra no refinador quando o modo está ativo, e uma
// lista opcional de submodos (os seletores Creator/Setting/Beat/Camera do UGC),
// cujas escolhas viram "Creative direction: ..." no fim do prompt.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE_NAME = "modes.json";

function slug(value) {
  return String(value || "")
    .toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

export function createModesStore({ dataDir, isReserved = () => false }) {
  const path = join(dataDir, FILE_NAME);

  function readAll() {
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return Array.isArray(parsed?.modes) ? parsed.modes : [];
    } catch (error) {
      console.warn(`modes.json ilegível (${error.message}); tratando como vazio`);
      return [];
    }
  }

  function writeAll(modes) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ modes }, null, 2));
  }

  // Validação explícita e com mensagem útil: um modo malformado só apareceria
  // como "o refinador ignorou meu modo", que é caro de diagnosticar depois.
  function normalize(input, { existingId = null } = {}) {
    const label = String(input?.label ?? "").trim();
    if (!label) throw new Error("O modo precisa de um nome.");
    const brief = String(input?.brief ?? "").trim();
    if (!brief) throw new Error("O modo precisa de uma instrução (brief): é ela que o refinador recebe.");

    const id = existingId ?? slug(input?.id || label);
    if (!id) throw new Error("Nome inválido para gerar um identificador.");
    if (!existingId && isReserved(id)) {
      throw new Error(`"${id}" é um modo de fábrica e não pode ser sobrescrito. Escolha outro nome.`);
    }

    const controls = [];
    for (const raw of input?.controls ?? []) {
      const controlLabel = String(raw?.label ?? "").trim();
      if (!controlLabel) continue;
      const options = (raw?.options ?? [])
        .map((option) => (typeof option === "string"
          ? { value: option.trim(), label: option.trim() }
          : { value: String(option?.value ?? "").trim(), label: String(option?.label ?? option?.value ?? "").trim() }))
        .filter((option) => option.value);
      // Um seletor sem opção não seleciona nada; guardá-lo só criaria um
      // controle morto na tela.
      if (!options.length) continue;
      controls.push({ id: slug(raw?.id || controlLabel), label: controlLabel, options });
    }

    return { id, label, brief, controls, custom: true, updated_at: new Date().toISOString() };
  }

  return {
    list: readAll,
    save(input) {
      const modes = readAll();
      const existing = input?.id ? modes.find((m) => m.id === input.id) : null;
      const mode = normalize(input, { existingId: existing?.id ?? null });
      const next = existing
        ? modes.map((m) => (m.id === mode.id ? mode : m))
        : [...modes, mode];
      writeAll(next);
      return mode;
    },
    remove(id) {
      const modes = readAll();
      const next = modes.filter((m) => m.id !== id);
      if (next.length === modes.length) return false;
      writeAll(next);
      return true;
    },
  };
}

export default createModesStore;
