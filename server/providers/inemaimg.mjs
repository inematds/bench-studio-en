// inemaimg.mjs — adapter do servidor local de imagem (DGX Spark GB10).
//
// Portado de img_inemaimg() em ~/projetos/videoanima-skill/provedores.py.
// Repo do servidor: ~/projetos/inemaimg (FastAPI em Docker).
//
// Diferenças que importam em relação aos providers remotos:
//
//   1. CUSTO ZERO E SEM RATE LIMIT. O recurso escasso aqui é a GPU, não dinheiro
//      nem cota. É o contraste que o ledger existe para mostrar.
//   2. RESPONDE EM BASE64, não em URL. Então o adapter grava o PNG ele mesmo e
//      devolve `local_path` — o núcleo detecta isso e pula o espelhamento, que
//      seria o servidor baixando de si próprio.
//   3. HOT-SWAP DE MODELO EM MEMÓRIA. O servidor mantém UM modelo carregado
//      (~32 GB de VRAM) e troca sob demanda. Alternar modelo a cada chamada
//      força descarregar/recarregar e destrói o tempo de uma sequência. Por
//      isso só flux2-klein está registrado: é o default do projeto, aceita até
//      4 referências nativamente e evita o swap.
//   4. PRECISA ESTAR NO AR. Se o container estiver parado, a mensagem tem que
//      dizer isso e como subir, não um "falha ao gerar" genérico.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = process.env.INEMAIMG_URL || "http://127.0.0.1:8000";
const TIMEOUT_MS = 600000;

function hint(detail) {
  return new Error(
    `inemaimg (${BASE}) não respondeu: ${detail}. ` +
    "O container está no ar? `cd ~/projetos/inemaimg && docker compose up -d`",
  );
}

export async function health() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Referências chegam como URL (http) ou data URI e o servidor as quer em base64
// CRU, sem o prefixo `data:`.
async function toBase64(ref) {
  if (typeof ref !== "string" || !ref) return null;
  if (ref.startsWith("data:")) return ref.split(",", 2)[1] ?? null;
  const url = ref.startsWith("/") ? `http://127.0.0.1:${process.env.PORT || 8787}${ref}` : ref;
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`referência inacessível (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer()).toString("base64");
}

function refsFrom(input) {
  const raw = [];
  for (const field of ["images", "image", "image_url", "image_urls", "reference_image_urls"]) {
    const v = input[field];
    if (Array.isArray(v)) raw.push(...v);
    else if (typeof v === "string" && v) raw.push(v);
  }
  // flux2-klein aceita até 4 referências nativamente.
  return raw.slice(0, 4);
}

function dimensions(size) {
  const m = /^(\d+)x(\d+)$/.exec(String(size ?? "").trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1312, height: 736 };
}

// Seed derivada do PROMPT, não constante — a razão está em provedores.py e é
// contraintuitiva o bastante para repetir: com seed FIXA, apagar um resultado
// ruim e rodar de novo devolve a MESMA imagem, e o retry vira ilusão de retry.
// Derivando do prompt, o resultado continua reproduzível (mesmo prompt -> mesma
// imagem) e mexer numa palavra é o que re-sorteia.
function seedFor(prompt, size) {
  const text = `${prompt}|${size}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function createInemaimgProvider({ outputsDir, mediaUrlBase = "/media" }) {
  async function submit(modelId, input) {
    // `inemaimg/flux2-klein/edit` e `inemaimg/flux2-klein` são o MESMO modelo no
    // servidor: o sufixo /edit existe só para o registry poder declarar a lane
    // i2i com o slot de referências. Mandar "flux2-klein/edit" devolve 404.
    const model = modelId.replace(/^inemaimg\//, "").replace(/\/edit$/, "");
    const size = String(input.size ?? "1312x736");
    const { width, height } = dimensions(size);
    const refs = [];
    for (const ref of refsFrom(input)) {
      try { const b64 = await toBase64(ref); if (b64) refs.push(b64); }
      catch (error) { console.warn(`inemaimg: referência ignorada (${error.message})`); }
    }

    const body = {
      model,
      prompt: input.prompt,
      width,
      height,
      seed: input.seed ?? seedFor(input.prompt, size),
      ...(input.steps === undefined ? {} : { steps: input.steps }),
      ...(input.guidance_scale === undefined ? {} : { guidance_scale: input.guidance_scale }),
      ...(input.negative_prompt ? { negative_prompt: input.negative_prompt } : {}),
      ...(refs.length ? { images: refs } : {}),
    };

    let response;
    try {
      response = await fetch(`${BASE}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) { throw hint(error.message); }

    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try { detail = JSON.parse(text)?.detail ?? text; } catch { /* corpo cru */ }
      throw new Error(`inemaimg recusou (HTTP ${response.status}): ${String(detail).slice(0, 300)}`);
    }

    const data = JSON.parse(text);
    const b64 = data.image ?? data.images?.[0];
    if (!b64) throw new Error("inemaimg respondeu sem imagem.");

    const filename = `inemaimg-${model}-${Date.now()}-0.png`;
    const localPath = join(outputsDir, filename);
    await writeFile(localPath, Buffer.from(b64, "base64"));

    return {
      request_id: `inemaimg-${Date.now()}`,
      inline: {
        images: [{
          url: `${mediaUrlBase}/${filename}`,
          local_path: localPath,
          local_url: `${mediaUrlBase}/${filename}`,
          content_type: "image/png",
          width,
          height,
        }],
      },
      meta: { model_used: data.model_used, generation_time_s: data.generation_time_s },
    };
  }

  return {
    label: "inemaimg (local, DGX)",
    // Servico local: a pergunta nao e "tem chave", e "esta no ar". A resposta e
    // assincrona e o servidor guarda em cache por um minuto.
    availability: async () => (await health())
      ? { available: true }
      : { available: false, reason: `Servidor local nao responde em ${BASE}`, hint: "cd ~/projetos/inemaimg && docker compose up -d. Custo zero." },
    // O adapter converte para base64 cru antes de enviar.
    accepts: { dataUri: true },
    submit,
    // Síncrono: quando submit volta, a imagem já está gravada.
    poll: (_modelId, handle) => Promise.resolve({ result: handle.inline, billableUnits: null }),
    quote: () => ({ cost: 0, confidence: "verified", basis: "local (DGX Spark), sem custo por chamada" }),
    actual: () => ({ cost: 0, confidence: "verified", basis: "local (DGX Spark), sem custo por chamada" }),
  };
}

export default createInemaimgProvider;
