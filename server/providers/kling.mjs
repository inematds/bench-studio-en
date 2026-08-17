// kling.mjs — adapter do Kling AI pelo CLI oficial (@klingai/cli-global).
//
// Diferente de todos os outros providers: não é HTTP com chave, é um SUBPROCESSO
// autenticado por OAuth (`kling login`, token em ~/.kling/.credentials). O molde
// de rodar processo externo já existia no projeto: server/project_runner.mjs.
// Conta: userId 3422648, plano SVIP/Pro — sem limite de tarefas concorrentes.
//
// Quatro coisas específicas deste provider moram aqui:
//
// 1. SEM RETRY AUTOMÁTICO. A própria ferramenta instrui: "Every job is charged;
//    do not submit trial jobs... Do not auto-resubmit or silently change intent
//    or parameters." Reenviar sozinho gastaria crédito do usuário sem ordem
//    dele. Falhou, falhou: a mensagem sobe e quem decide é a pessoa.
// 2. O CLI TRUNCA A SAÍDA EM 65536 BYTES quando stdout é um pipe (medido
//    2026-08-16). Toda captura passa por arquivo temporário — ver klingJson().
// 3. Cobra em CRÉDITOS do plano. `kling account` expõe o saldo, então o consumo
//    real é medido pelo delta, como no kie. Sem taxa crédito->dólar publicada, o
//    valor em dólar fica null em vez de inventado.
// 4. As URLs de resultado EXPIRAM EM 24H. O núcleo já espelha na hora
//    (mirrorOutputs), então isso está coberto — mas é o motivo de nunca guardar
//    só o link.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 10000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

// Ver nota 2 no cabeçalho: capturar pelo pipe corta em 64 KB e devolve JSON
// cortado no meio de uma string.
async function klingJson(args, { timeoutMs = 15 * 60 * 1000 } = {}) {
  const tmp = join(tmpdir(), `kling-${randomUUID()}.json`);
  try {
    const quoted = args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ");
    await run("bash", ["-lc", `kling ${quoted} > ${tmp} 2>/dev/null`], { timeout: timeoutMs });
    const raw = readFileSync(tmp, "utf8").trim();
    if (!raw) throw new Error("o CLI do Kling não devolveu saída (sessão expirada? rode `kling login`)");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("CLI do Kling não encontrado. `npm i -g @klingai/cli-global`");
    throw error;
  } finally {
    try { unlinkSync(tmp); } catch { /* já foi */ }
  }
}

async function credits() {
  try {
    const d = await klingJson(["account"], { timeoutMs: 60000 });
    const v = d?.body?.availableRemainCredits;
    return typeof v === "number" ? v : null;
  } catch { return null; }
}

// `kling/kling-video-v3_0_turbo/i2v` -> { model, tool }
function route(modelId) {
  const rest = modelId.replace(/^kling\//, "");
  if (rest.endsWith("/i2v")) return { model: rest.slice(0, -4), tool: "image_to_video" };
  if (rest.endsWith("/edit")) return { model: rest.slice(0, -5), tool: "image_to_image" };
  return { model: rest, tool: rest.startsWith("kling-video") ? "text_to_video" : "text_to_image" };
}

function referenceFrom(input) {
  for (const field of ["image", "image_url", "images", "image_urls"]) {
    const v = input[field];
    const first = Array.isArray(v) ? v[0] : v;
    if (typeof first === "string" && first) return first;
  }
  return null;
}

// Parâmetros do modelo viram flags `--nome valor`. Só entram os que o registry
// declarou para AQUELE modelo — mandar flag que o modelo não declara faz o
// servidor recusar, e é justamente o que a ferramenta pede para não fazer
// ("do not invent names or value").
function flagsFor(model, input, declared) {
  const flags = [];
  for (const [name, value] of Object.entries(input)) {
    if (["prompt", "image", "image_url", "images", "image_urls"].includes(name)) continue;
    if (value === undefined || value === null || value === "") continue;
    if (declared && !declared[name]) continue;
    flags.push(`--${name}`, String(value));
  }
  return flags;
}

export function createKlingProvider({ modelById } = {}) {
  async function submit(modelId, input) {
    const { model, tool } = route(modelId);
    const declared = modelById?.(modelId)?.params ?? null;
    const reference = referenceFrom(input);
    if ((tool === "image_to_video" || tool === "image_to_image") && !reference) {
      throw new Error(`${modelId} precisa de uma imagem de referência.`);
    }

    const before = await credits();
    const args = [tool, "--model", model, ...flagsFor(model, input, declared)];
    if (reference) args.push("--image", reference);
    args.push(input.prompt ?? "");

    const out = await klingJson(args);
    if (out?.ok === false) {
      throw new Error(`Kling recusou: ${JSON.stringify(out.body ?? out).slice(0, 300)}`);
    }
    const body = out?.body ?? out;
    const id = body?.generation_id ?? body?.generationId ?? body?.data?.generation_id;
    if (!id) throw new Error(`Kling não devolveu generation_id: ${JSON.stringify(body).slice(0, 250)}`);
    return { request_id: id, credits_before: before };
  }

  async function poll(modelId, handle, { onUpdate } = {}) {
    const started = Date.now();
    while (Date.now() - started < JOB_TIMEOUT_MS) {
      await sleep(POLL_MS);
      let body;
      try {
        const out = await klingJson(["query_tasks", handle.request_id], { timeoutMs: 120000 });
        body = out?.body ?? out;
      } catch {
        // Consulta que falha não mata a tarefa: ela segue rodando no Kling.
        onUpdate?.({ status: "IN_QUEUE" });
        continue;
      }

      const task = Array.isArray(body?.tasks) ? body.tasks[0] : (body?.task ?? body);
      const status = String(task?.status ?? task?.state ?? "").toLowerCase();
      const works = task?.works ?? body?.works ?? [];
      const urls = works.map((w) => w?.url ?? w?.resource?.resource).filter(Boolean);

      if (urls.length) {
        const after = await credits();
        const used = handle.credits_before != null && after != null
          ? Number((handle.credits_before - after).toFixed(2))
          : null;
        const isVideo = /video/.test(modelId) || /\.(mp4|mov|webm)(\?|$)/i.test(urls[0]);
        return {
          result: isVideo
            ? { video: { url: urls[0], content_type: "video/mp4" } }
            : { images: urls.map((url) => ({ url, content_type: "image/png" })) },
          billableUnits: used,
        };
      }
      if (["failed", "error"].includes(status)) {
        throw new Error(`Kling reportou falha: ${JSON.stringify(task).slice(0, 250)}`);
      }
      onUpdate?.({ status: status === "processing" ? "IN_PROGRESS" : "IN_QUEUE" });
    }
    throw new Error("Kling: tempo esgotado (30 min). A tarefa pode ainda concluir no site.");
  }

  // Consome CRÉDITOS do plano Pro, não dólar avulso. Não há taxa publicada de
  // crédito para dólar, então o custo em dólar fica NULL — explicitamente
  // desconhecido. Inventar um número aqui poluiria o total gasto do ledger, que
  // é o número que dá sentido ao app. O crédito medido vai no recibo.
  const quote = () => ({
    cost: null,
    confidence: "unquotable",
    basis: "consome créditos do plano Kling Pro (SVIP), não dólar avulso; o consumo real é medido após a geração",
    unit: "credits",
  });

  return {
    label: "Kling (CLI oficial)",
    // Nao basta a chave: aqui o acesso e por CLI autenticado. Checar o arquivo de
    // credencial e barato; chamar `kling account` leva segundos e nao cabe num
    // carregamento de catalogo.
    availability: () => existsSync(join(homedir(), ".kling", ".credentials"))
      ? { available: true }
      : { available: false, reason: "Kling nao autenticado", hint: "npm i -g @klingai/cli-global && kling login. Consome creditos do plano." },
    // O CLI recebe caminho local e faz o upload sozinho.
    accepts: { localPath: true },
    submit,
    poll,
    quote,
    actual: (_modelId, billableUnits) => (billableUnits == null ? null : {
      cost: null,
      confidence: "verified (créditos)",
      basis: `${billableUnits} créditos Kling consumidos (medido pelo saldo da conta)`,
      unit: "credits",
      billable_units: billableUnits,
    }),
  };
}

export default createKlingProvider;
