// agnes.mjs — adapter do Agnes AI para a camada PROVIDERS.
//
// Portado de ~/projetos/videoanima-skill/provedores.py (img_agnes, agnes_submit,
// agnes_estado, vid_agnes), que já roda isto em produção. As armadilhas abaixo
// foram MEDIDAS em ~70 chamadas reais (~/projetos/videos-agnes/README.md e
// ~/projetos/agnes-nei/NOTAS-API.md), não lidas da documentação oficial — em
// vários pontos a doc e a prática divergem, e aqui vale a prática.
//
// Gateway: apihub.agnes-ai.com (litellm sobre one-api). Custo: US$ 0.
//
// Armadilhas que moram AQUI, e não no núcleo:
//   - prompt em INGLÊS: em PT a API recusa conteúdo legítimo com HTTP 400;
//   - ~34% das chamadas devolvem 503 -> retry com backoff recupera quase 100%;
//   - `ratio` é IGNORADO em img2img -> mandar `size` em pixels explícitos;
//   - máximo 2 referências úteis (5 viram confete e o prompt é ignorado);
//   - rate limit de 5/min na criação de vídeo E TAMBÉM no polling -> espaçar;
//   - job morto responde 400/404 na consulta, não um status "failed";
//   - a URL de saída é temporária -> o núcleo já espelha com mirrorOutputs();
//   - params desconhecidos são descartados em silêncio (litellm drop_params):
//     HTTP 200 não prova que o parâmetro foi usado.

const BASE = "https://apihub.agnes-ai.com";
const FPS = 24;

// Medido: o polling tem rate limit próprio. A malha do fal usa 2s; aqui isso
// derrubaria a consulta em 429. Nunca reaproveitar a constante do fal.
const POLL_MS = 15000;
const SUBMIT_TIMEOUT_MS = 300000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function key() {
  const k = process.env.AGNES_API_KEY;
  if (!k) throw new Error("AGNES_API_KEY ausente. Ver ~/projetos/agnes-nei/.env");
  return k;
}

const headers = () => ({ Authorization: `Bearer ${key()}`, "Content-Type": "application/json" });

class AgnesHttpError extends Error {
  constructor(status, body) {
    super(`agnes ${status}: ${String(body).slice(0, 200)}`);
    this.status = status;
    this.body = String(body);
  }
}

async function post(path, body, timeoutMs = SUBMIT_TIMEOUT_MS) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new AgnesHttpError(res.status, text);
  return JSON.parse(text);
}

async function get(path, timeoutMs = 120000) {
  const res = await fetch(`${BASE}${path}`, {
    headers: headers(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new AgnesHttpError(res.status, text);
  return JSON.parse(text);
}

// O núcleo troca qualquer erro por "a geração não pôde ser iniciada", o que
// esconde exatamente a informação que resolve o problema. A Agnes responde 400
// com uma mensagem útil de verdade (ex.: `mode must be omitted for
// text-to-video...`), então repassamos a mensagem dela. Só quando o 400 cheira
// a filtro de conteúdo acrescentamos a dica do português — que é a causa mais
// comum medida, mas não é a única causa de 400.
function translateError(error) {
  if (!(error instanceof AgnesHttpError) || error.status !== 400) return error;
  let detail = error.body;
  try {
    const parsed = JSON.parse(error.body);
    detail = parsed?.message ?? parsed?.error?.message ?? error.body;
  } catch { /* corpo não-JSON: usa cru */ }
  const looksLikeContentFilter = /content|policy|filter|safety|blocked/i.test(String(detail));
  const hint = looksLikeContentFilter
    ? " Causa mais comum medida: prompt em português — a API filtra conteúdo legítimo em PT e aceita o mesmo pedido em inglês."
    : "";
  return new Error(`Agnes recusou o pedido (400): ${String(detail).slice(0, 300)}.${hint}`);
}

// `agnes/agnes-image-2.1-flash/edit` e `agnes/agnes-video-v2.0/i2v` são, na API,
// os MESMOS modelos de `.../agnes-image-2.1-flash` e `.../agnes-video-v2.0`. Os
// sufixos existem só para o registry poder declarar as lanes i2i e i2v com slot
// de referência — o que muda é o payload, não o modelo. Mandar o sufixo devolve
//   503 model_not_found: No available channel for model agnes-image-2.1-flash/edit
// Este é o mesmo erro que o inemaimg deu com /edit; aqui ele passou despercebido
// porque só os caminhos t2i e t2v tinham sido testados.
function apiModel(modelId) {
  return modelId.replace(/^agnes\//, "").replace(/\/(edit|i2v)$/, "");
}

// Um 503 normalmente É transitório na Agnes (~34% das chamadas), e por isso o
// retry existe. Mas `model_not_found` vem embrulhado em 503 e nunca vai melhorar
// tentando de novo: insistir só gasta minutos de backoff antes de dar o mesmo
// erro. Separar os dois casos é a diferença entre um retry útil e uma espera inútil.
function isPermanent(error) {
  return error instanceof AgnesHttpError
    && /model_not_found|invalid_request|unsupported/i.test(error.body);
}

// Agnes: num_frames segue 8n+1, teto 441 (18,4s @24fps).
export function framesFor(seconds) {
  const n = Math.round((Number(seconds || 3.4) * FPS - 1) / 8);
  return Math.max(9, Math.min(441, Math.trunc(n) * 8 + 1));
}

// "1312x736" -> { width, height }. O núcleo entrega `size` como string porque é
// assim que o registry declara o controle (ratio é inútil aqui, ver acima).
function dimensions(size) {
  const m = /^(\d+)x(\d+)$/.exec(String(size ?? "").trim());
  if (!m) return { width: 1312, height: 736 };
  return { width: Number(m[1]), height: Number(m[2]) };
}

function refsFrom(input) {
  const raw = [];
  for (const field of ["image", "image_url", "image_urls", "reference_image_urls", "start_image_url", "end_image_url"]) {
    const v = input[field];
    if (Array.isArray(v)) raw.push(...v);
    else if (typeof v === "string" && v) raw.push(v);
  }
  // Medido: 2 é o teto útil. Acima disso a saída degrada e o prompt é ignorado,
  // então cortar aqui é melhor que deixar o usuário pagar por lixo (mesmo a $0).
  return raw.slice(0, 2);
}

// ------------------------------------------------------------------ imagem
// Síncrono: uma chamada devolve a URL. O retry com backoff não é zelo, é
// obrigatório — ~34% de 503 medido.
async function submitImage(modelId, input) {
  const refs = refsFrom(input);
  const body = {
    model: apiModel(modelId),
    prompt: input.prompt,
    size: String(input.size ?? "1312x736"),
    extra_body: { response_format: "url" },
  };
  if (refs.length) body.extra_body.image = refs;

  let last;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const data = await post("/v1/images/generations", body);
      const url = data?.data?.[0]?.url;
      if (!url) throw new Error(`resposta sem url: ${JSON.stringify(data).slice(0, 200)}`);
      return { request_id: `agnes-img-${Date.now()}-${attempt}`, inline: { images: [{ url, content_type: "image/png" }] } };
    } catch (error) {
      last = translateError(error);
      if (isPermanent(error) || (error instanceof AgnesHttpError && error.status === 400)) throw last;
      await sleep(4000 * attempt);
    }
  }
  throw last;
}

// ------------------------------------------------------------------ vídeo
// Assíncrono: POST /v1/videos -> video_id, depois GET /agnesapi?video_id=...
async function submitVideo(modelId, input) {
  const refs = refsFrom(input);
  const { width, height } = dimensions(input.size ?? "1312x736");
  const body = {
    model: apiModel(modelId),
    prompt: input.prompt,
    num_frames: framesFor(input.duration),
    frame_rate: FPS,
    width,
    height,
    // Diferente da imagem, o vídeo TEM seed e negative_prompt de verdade.
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.negative_prompt ? { negative_prompt: input.negative_prompt } : {}),
    extra_body: {
      ...(refs.length ? { image: refs } : {}),
      // MEDIDO contra a API viva (2026-08-16), e diferente do que a doc antiga
      // dizia: `mode` só aceita "keyframes" e precisa ser OMITIDO para
      // text-to-video e para imagem única. Mandar "t2v" ou "ti2vid" devolve
      //   400 invalid_request: mode must be omitted for text-to-video or
      //   single-image video, or set to keyframes for keyframe video
      // Com 2 referências, "keyframes" interpola A->B de verdade.
      ...(refs.length >= 2 ? { mode: "keyframes" } : {}),
    },
  };

  let last;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const data = await post("/v1/videos", body);
      const id = data?.video_id ?? data?.task_id ?? data?.id;
      if (!id) throw new Error(`submit sem video_id: ${JSON.stringify(data).slice(0, 200)}`);
      return { request_id: id };
    } catch (error) {
      last = translateError(error);
      if (isPermanent(error) || (error instanceof AgnesHttpError && error.status === 400)) throw last;
      // Rate limit de criação é 5/min: recuar 70s é o que funciona, não 6s.
      await sleep(error instanceof AgnesHttpError && error.status === 429 ? 70000 : 6000 * attempt);
    }
  }
  throw last;
}

async function pollVideo(modelId, handle, { onUpdate } = {}) {
  const started = Date.now();
  while (Date.now() - started < JOB_TIMEOUT_MS) {
    await sleep(POLL_MS);
    let data;
    try {
      data = await get(`/agnesapi?video_id=${encodeURIComponent(handle.request_id)}`);
    } catch (error) {
      // MEDIDO: job morto do lado da Agnes passa a responder 400/404 na consulta
      // em vez de devolver status "failed". Tratar isso como "ainda esperando"
      // prendia o job na fila até o prazo inteiro em vez de falhar em segundos.
      if (error instanceof AgnesHttpError && (error.status === 400 || error.status === 404)) {
        throw new Error(`Agnes descartou este job (HTTP ${error.status}).`);
      }
      onUpdate?.({ status: "IN_QUEUE" });
      continue;
    }
    const status = data?.status;
    onUpdate?.({ status: status === "in_progress" ? "IN_PROGRESS" : "IN_QUEUE" });
    if (status === "completed") {
      const url = data?.url ?? data?.data?.[0]?.url ?? data?.video_url;
      if (!url) throw new Error("Agnes concluiu sem devolver a URL do vídeo.");
      return { result: { video: { url, content_type: "video/mp4" } }, billableUnits: null };
    }
    if (status === "failed") throw new Error("Agnes reportou falha na geração.");
  }
  throw new Error("Agnes: tempo esgotado (30 min).");
}

// ------------------------------------------------------------------ adapter
const isVideo = (modelId) => modelId.includes("video");

export const agnesProvider = {
  label: "Agnes AI",
  // Disponibilidade e FATO, nao preferencia: ou a chave existe, ou nao existe.
  // Calculada na hora e nunca gravada, porque muda sozinha.
  availability: () => process.env.AGNES_API_KEY
    ? { available: true }
    : { available: false, reason: "Falta AGNES_API_KEY", hint: "Chave do gateway apihub.agnes-ai.com. Geracao gratuita." },
  // Aceita base64 (medido: a doc afirma exigir URL publica, e falso).
  accepts: { dataUri: true },
  submit: (modelId, input) => (isVideo(modelId) ? submitVideo(modelId, input) : submitImage(modelId, input)),
  poll: (modelId, handle, opts) =>
    isVideo(modelId) ? pollVideo(modelId, handle, opts) : Promise.resolve({ result: handle.inline, billableUnits: null }),
  // Sem créditos e sem cobrança. Verificado, não estimado: o zero aqui é um
  // fato do provedor, e é justamente o contraste que o ledger existe pra mostrar.
  quote: () => ({ cost: 0, confidence: "verified", basis: "Agnes free tier (US$ 0)" }),
  actual: () => ({ cost: 0, confidence: "verified", basis: "Agnes free tier (US$ 0)" }),
};

export default agnesProvider;
