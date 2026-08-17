// kling_sync.mjs — gera kling.models.json a partir do `kling who_am_i`.
//
//   node server/providers/kling_sync.mjs
//
// O Kling publica o schema de cada modelo (parâmetros, defaults e allowedValues)
// no próprio `who_am_i`. É o mesmo truque que o build_registry.mjs usa com o
// OpenAPI do fal: em vez de manter 26 modelos à mão, o catálogo se constrói
// sozinho e envelhece junto com a conta. Rodar de novo quando o Kling lançar
// modelo novo ou o plano mudar.

import { execFile } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

export async function klingJson(args) {
  const tmp = join(tmpdir(), `kling-${randomUUID()}.json`);
  try {
    const quoted = args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ");
    await run("bash", ["-lc", `kling ${quoted} > ${tmp} 2>/dev/null`], { timeout: 15 * 60 * 1000 });
    return readFileSync(tmp, "utf8");
  } finally {
    try { unlinkSync(tmp); } catch { /* já foi */ }
  }
}

const TOOL_LANE = {
  text_to_video: { kind: "video", lane: "t2v", category: "text-to-video", suffix: "" },
  image_to_video: { kind: "video", lane: "i2v", category: "image-to-video", suffix: "/i2v" },
  text_to_image: { kind: "image", lane: "t2i", category: "text-to-image", suffix: "" },
  image_to_image: { kind: "image", lane: "i2i", category: "image-editing", suffix: "/edit" },
};

// Modelos de terceiros que o Kling revende e que o Bench também tem via fal
// (gemini-*, gpt-image-*). Eles ENTRAM de propósito: a mesma família por duas
// rotas com contas e cobranças diferentes é justamente a escolha que o estudio
// existe para deixar visivel — fal cobra em dolar com preço ao vivo, Kling
// consome credito do plano Pro. O label diz a rota para nao haver ambiguidade
// na hora de escolher.
const RESOLD = /^(gemini|gpt-image)/i;

// Defaults do Nei (~/projetos/klingai-nei/README.md), aplicados quando o modelo
// permite: 720p sempre, porque resolução alta multiplica o consumo de créditos e
// 1080p/4K só entram sob pedido explícito.
const PREFER = { resolution: "720p", img_resolution: "1k" };

function paramsFrom(args) {
  const params = {};
  for (const a of args ?? []) {
    if (a.name === "prompt") continue;
    const allowed = a.allowedValues ?? a.allowed_values;
    const spec = {
      name: a.name,
      type: allowed ? "string" : "string",
      title: a.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      description: a.description ?? "",
    };
    if (allowed?.length) {
      spec.enum = allowed.map(String);
      const preferred = PREFER[a.name];
      spec.default = preferred && spec.enum.includes(preferred) ? preferred : String(a.default ?? spec.enum[0]);
      if (preferred && spec.default === preferred && String(a.default) !== preferred) {
        spec.description += ` (default do Bench forçado para ${preferred}: resolução alta multiplica o consumo de créditos; subir é decisão explícita)`;
      }
    } else if (a.default !== undefined) {
      spec.default = String(a.default);
    }
    params[a.name] = spec;
  }
  return params;
}

const IMAGE_INPUT = {
  name: "image",
  type: "string",
  title: "Imagem",
  description: "Imagem de referência. O CLI aceita URL pública ou caminho local e faz o upload sozinho.",
  modality: "image",
  role: "source",
  arity: "single",
  required: true,
};

// MEDIDO 2026-08-16: o CLI do Kling TRUNCA a saída em exatamente 65536 bytes
// quando stdout é um pipe — ele encerra antes de esvaziar o buffer. O
// `who_am_i` tem ~187 KB, então capturar pelo pipe devolve JSON cortado no meio
// de uma string ("Unterminated string in JSON"). Redirecionado para arquivo vem
// inteiro. Por isso aqui, e no adapter, a saída passa por arquivo temporário.
const body = JSON.parse(await klingJson(["who_am_i"])).body;
const models = [];

for (const [tool, meta] of Object.entries(TOOL_LANE)) {
  for (const m of body.availableModels?.[tool]?.models ?? []) {
    const wantsImage = meta.lane === "i2v" || meta.lane === "i2i";
    models.push({
      id: `kling/${m.model}${meta.suffix}`,
      provider: "kling",
      kind: meta.kind,
      lane: meta.lane,
      label: `${m.model.replace(/^kling-(video|image)-/, "Kling ").replace(/_/g, ".")}${wantsImage ? (meta.lane === "i2v" ? " i2v" : " edit") : ""} · via Kling`,
      resold: RESOLD.test(m.model) || null,
      vendor: "Kuaishou",
      category: meta.category,
      thumbnail: null,
      alias: m.alias ?? null,
      description: m.description ?? null,
      image_input: wantsImage ? { name: "image", arity: "single", required: true } : null,
      image_inputs: wantsImage ? ["image"] : [],
      media_inputs: wantsImage ? [IMAGE_INPUT] : [],
      accepts_image: wantsImage ? "single" : null,
      image_param: wantsImage ? "image" : null,
      required: wantsImage ? ["image"] : ["prompt"],
      params: paramsFrom(m.arguments),
    });
  }
}

const out = {
  _meta: {
    provider: "kling",
    generated_at: new Date().toISOString(),
    source: "kling who_am_i (CLI oficial @klingai/cli-global)",
    account: `userId ${body.user?.userId ?? "?"}`,
    regenerate: "node server/providers/kling_sync.mjs",
    revendidos: "gemini-* e gpt-image-* aparecem TAMBEM aqui, alem da rota fal: e a escolha de rota (dolar no fal x credito do plano no Kling) que o estudio existe para tornar visivel. O label traz `via Kling`.",
    note: "Defaults de resolucao forcados para 720p/1k conforme ~/projetos/klingai-nei/README.md — resolucao alta multiplica creditos.",
  },
  models,
};
writeFileSync(join(HERE, "kling.models.json"), JSON.stringify(out, null, 2));
console.log(`kling.models.json: ${models.length} modelos`);
for (const m of models) console.log(`  ${m.id}`);
