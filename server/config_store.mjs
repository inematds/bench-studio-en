// config_store.mjs — o que o estúdio precisa saber para funcionar, e de onde veio.
//
// Uma regra acima de tudo: VALOR DE CHAVE NUNCA SAI DAQUI PARA O NAVEGADOR.
// Este módulo responde "existe?", "veio de onde?" e "termina em quê?" — nunca
// "qual é". Quem quiser o valor lê o arquivo no disco, com as permissões do
// sistema operacional, que é exatamente onde essa decisão deve morar.

import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ENV = join(HERE, "..", ".env");
export const HOME_ENV = join(homedir(), ".env");

// O catálogo é declarado, não descoberto: uma variável que ninguém documentou
// não deve aparecer numa tela de configuração como se fosse suportada. `secret`
// decide se o valor pode ser mostrado — URL local não é segredo, chave é.
export const FIELDS = [
  { key: "FAL_KEY", group: "generation", secret: true, label: "fal.ai", effect: "37 models (FLUX, Veo, Kling, Seedance, Hailuo, Wan, LTX, Grok). Billed in dollars.", help: "https://fal.ai/dashboard/keys" },
  { key: "AGNES_API_KEY", group: "generation", secret: true, label: "Agnes AI", effect: "4 image and video models at zero cost. Requires English prompts.", help: "https://apihub.agnes-ai.com" },
  { key: "KIE_API_KEY", group: "generation", secret: true, label: "kie.ai", effect: "4 models billed in credits (Z-Image, Veo 3 fast).", help: "https://kie.ai/api-key" },

  { key: "INEMAIMG_URL", group: "local", secret: false, fallback: "http://127.0.0.1:8000", label: "inemaimg", effect: "2 local models on your own GPU (FLUX.2, Qwen-Edit). Zero cost.", help: "https://github.com/inematds/inemaimg" },
  { key: "OLLAMA_URL", group: "local", secret: false, fallback: "http://127.0.0.1:11434", label: "ollama", effect: "Local engine for the website and document builder. Needs a GPU.", help: "https://ollama.com" },

  { key: "GOOGLE_API_KEY", group: "refine", secret: true, label: "Google AI Studio", effect: "First link of the prompt rewriter (gemini-3-flash-preview).", help: "https://aistudio.google.com/apikey" },
  { key: "OPENROUTER_API_KEY", group: "refine", secret: true, label: "OpenRouter", effect: "Second link of the rewriter, and a model engine for the builder.", help: "https://openrouter.ai/keys" },
  { key: "OPENROUTER_BASE_URL", group: "refine", secret: false, fallback: "https://openrouter.ai/api/v1", label: "OpenRouter base URL", effect: "Defaults to https://openrouter.ai/api/v1." },
  { key: "OPENROUTER_MODEL_DEFAULT", group: "refine", secret: false, label: "OpenRouter model", effect: "A retired model id here returns 404 and drops the link. Check openrouter.ai/models." },

  { key: "BENCH_WEBSITE_REFERENCE", group: "reference", secret: false, label: "Website reference", effect: "A site of YOURS the builder may inspect to calibrate finish. Never copied." },
  { key: "BENCH_WEBSITE_REFERENCE_URL", group: "reference", secret: false, label: "Website reference URL", effect: "Only used to show the preview in the side panel." },
  { key: "BENCH_DOCUMENT_REFERENCE", group: "reference", secret: false, label: "Document reference", effect: "A PDF of YOURS used the same way for documents." },

  // O valor guardado aqui e um HASH scrypt, nunca a senha. Fica marcado como
  // segredo por higiene: nem o hash precisa aparecer numa tela.
  { key: "BENCH_PASSWORD", group: "access", secret: true, label: "Studio password", effect: "Empty means no password — the studio opens straight away, which is the default. Set one and everyone needs it to reach the API." },

  { key: "PORT", group: "server", secret: false, fallback: "8787", label: "API port", effect: "Defaults to 8787. The interface runs on 5200." },
  { key: "BENCH_DATA_DIR", group: "server", secret: false, fallback: "./data", label: "Data directory", effect: "Where the database, outputs and projects live. Defaults to ./data." },
  { key: "BENCH_CHROME", group: "server", secret: false, label: "Chrome path", effect: "Used to print PDFs. Detected automatically; set only if it lives somewhere unusual." },
  { key: "FFMPEG_PATH", group: "server", secret: false, label: "ffmpeg path", effect: "Set only if ffmpeg is not on PATH." },
];

export const GROUPS = [
  { id: "generation", label: "Image and video providers", note: "Nothing here is required together. The studio starts with whatever exists and marks the rest unavailable." },
  { id: "local", label: "Local models", note: "Run on your own machine, at zero cost. A URL that answers nothing simply shows as unavailable." },
  { id: "refine", label: "Prompt refine", note: "Rewrites your idea into the style each model expects, and into English (which Agnes requires). Order: Gemini, then OpenRouter, then the local Codex CLI. Having more than one keeps an exhausted quota from taking the studio down." },
  { id: "reference", label: "Craft reference", note: "Paths on this machine. They are read for calibration only — brand, copy, structure and files are never copied." },
  { id: "access", label: "Access", note: "The studio ships with no password, on purpose: talking to your own machine should not need one. A password protects the API — your models, results, media, ledger and settings. The interface shell is still served to anyone who reaches the port, but without a session it shows nothing; hiding the shell too is a job for a reverse proxy." },
  { id: "server", label: "Server", note: "Changes here only take effect after the server restarts." },
];

const KNOWN = new Set(FIELDS.map((f) => f.key));

// ------------------------------------------------------------------ leitura

// Parser deliberadamente igual ao loadEnv() do server: se os dois lessem o
// arquivo de formas diferentes, a tela mostraria uma coisa e o servidor usaria
// outra — que é o pior defeito possível numa tela de configuração.
export function parseEnvFile(text) {
  const out = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out.set(t.slice(0, i).trim(), t.slice(i + 1).trim().replace(/^["']|["']$/g, ""));
  }
  return out;
}

function readFileMap(path) {
  if (!path || !existsSync(path)) return new Map();
  try { return parseEnvFile(readFileSync(path, "utf8")); } catch { return new Map(); }
}

// Últimos 4 caracteres. Não é "meio segredo": é o suficiente para conferir se a
// chave no servidor é a mesma que está no seu gerenciador de senhas, e pouco
// demais para servir a quem interceptar a resposta.
function maskedTail(value) {
  const v = String(value ?? "");
  if (!v) return null;
  return v.length <= 4 ? "•".repeat(v.length) : `…${v.slice(-4)}`;
}

/**
 * Estado de cada variável: existe, de onde veio, e se uma gravação teria efeito.
 *
 * A precedência é a mesma do servidor — ambiente exportado > .env do projeto >
 * ~/.env — e é justamente por isso que `shadowed` existe: gravar no .env do
 * projeto uma chave que o shell já exportou NÃO muda nada até reiniciar sem
 * aquele export. Sem esse aviso, a tela mentiria dizendo "salvo".
 */
export function describeConfig({ env = process.env, projectPath = PROJECT_ENV, homePath = HOME_ENV } = {}) {
  const project = readFileMap(projectPath);
  const home = readFileMap(homePath);

  const fields = FIELDS.map((field) => {
    const inProject = project.has(field.key) && project.get(field.key) !== "";
    const inHome = home.has(field.key) && home.get(field.key) !== "";
    const live = env[field.key];
    const present = Boolean(live) || inProject || inHome;

    // Uma variável presente no ambiente E ausente dos dois arquivos só pode ter
    // vindo de fora (export do shell, dev.sh, systemd, docker -e).
    let source = null;
    if (live && !inProject && !inHome) source = "exported";
    else if (live && inProject) source = "project_env";
    else if (live && inHome) source = "home_env";
    else if (inProject) source = "project_env";
    else if (inHome) source = "home_env";

    // Se o valor vivo não bate com o do arquivo, quem manda é o export.
    const shadowed = Boolean(live) && inProject && live !== project.get(field.key);

    return {
      ...field,
      present,
      source,
      shadowed,
      // Uma variavel com valor padrao FUNCIONA vazia. Marcar isso como "not set"
      // manda a pessoa procurar problema onde nao ha — e pior, sugere preencher
      // algo que nao precisa existir.
      using_fallback: !present && Boolean(field.fallback),
      masked_tail: field.secret ? maskedTail(live ?? project.get(field.key) ?? home.get(field.key)) : null,
      value: field.secret ? null : (live ?? project.get(field.key) ?? home.get(field.key) ?? ""),
    };
  });

  return {
    groups: GROUPS,
    fields,
    project_env_path: projectPath,
    project_env_exists: existsSync(projectPath),
    home_env_path: homePath,
    home_env_exists: existsSync(homePath),
  };
}

// ------------------------------------------------------------------ escrita

/**
 * Reescreve o texto do .env aplicando `patch`, preservando comentários, ordem e
 * qualquer variável que este módulo não conheça — o arquivo é do usuário, não
 * nosso. Chave com valor vazio no patch é REMOVIDA, que é como se apaga uma
 * chave sem precisar de um segundo verbo.
 */
export function mergeEnvText(text, patch) {
  // Arquivo inexistente ou só com espaço em branco não tem linha nenhuma para
  // preservar; tratar "" como [""] deixaria uma linha vazia no topo do arquivo.
  const original = String(text ?? "");
  const linhas = original.trim() === "" ? [] : original.split("\n");
  const pendentes = new Map(Object.entries(patch));
  const saida = [];

  for (const linha of linhas) {
    const t = linha.trim();
    const i = t.indexOf("=");
    const chave = !t || t.startsWith("#") || i === -1 ? null : t.slice(0, i).trim();
    if (chave === null || !pendentes.has(chave)) { saida.push(linha); continue; }
    const valor = pendentes.get(chave);
    pendentes.delete(chave);
    if (valor === "") continue; // removida
    saida.push(`${chave}=${valor}`);
  }

  const novas = [...pendentes.entries()].filter(([, v]) => v !== "");
  if (novas.length) {
    if (saida.length && saida[saida.length - 1].trim() !== "") saida.push("");
    for (const [k, v] of novas) saida.push(`${k}=${v}`);
  }

  const texto = saida.join("\n");
  return texto.endsWith("\n") || texto === "" ? texto : `${texto}\n`;
}

// Valor de uma linha de .env não pode conter quebra de linha: uma cola acidental
// com "\n" transformaria uma chave em duas variáveis, e a segunda seria lixo
// silencioso no arquivo do usuário.
export function validatePatch(patch) {
  const limpo = {};
  for (const [k, raw] of Object.entries(patch ?? {})) {
    if (!KNOWN.has(k)) return { error: `Unknown setting: ${k}` };
    const v = String(raw ?? "").trim();
    if (/[\n\r]/.test(v)) return { error: `${k} cannot contain a line break` };
    limpo[k] = v;
  }
  return { patch: limpo };
}

/**
 * Grava de forma atômica e com permissão restrita. A ordem importa: chmod ANTES
 * do rename, senão existe uma janela — pequena, mas real — em que o arquivo com
 * as chaves está legível para qualquer usuário da máquina.
 */
export function writeConfig(patch, { projectPath = PROJECT_ENV } = {}) {
  const atual = existsSync(projectPath) ? readFileSync(projectPath, "utf8") : "";
  const texto = mergeEnvText(atual, patch);
  const tmp = `${projectPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, texto, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, projectPath);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw e;
  }
  return { written: Object.keys(patch), path: projectPath };
}

// ------------------------------------------------------------------ acesso

function enderecoLocal(addr) {
  const limpo = String(addr ?? "").trim().replace(/^::ffff:/, "");
  return limpo === "127.0.0.1" || limpo === "::1" || limpo.startsWith("127.");
}

/**
 * Gravar chave é privilégio de quem está NA máquina. `--lan` publica a
 * interface para a rede inteira; sem esta trava, qualquer um no mesmo wifi
 * trocaria as chaves do dono.
 *
 * O detalhe que quase passou: o navegador NÃO fala com esta API direto — fala
 * com o Vite, que repassa. Quem abre o socket é o proxy, na mesma máquina, então
 * olhar só o socket faz TODO mundo parecer local. Medido: pela porta da
 * interface, um cliente da LAN vinha como local; pela porta da API, não.
 *
 * Por isso X-Forwarded-For entra na conta — mas só quando o socket já é local.
 * Essa condição é o que torna o cabeçalho confiável: quem vem de fora não
 * consegue abrir um socket loopback, então não consegue forjar a origem. Um
 * cabeçalho aceito sem essa guarda seria pior do que não ter trava nenhuma.
 */
export function isLoopback(req) {
  if (!enderecoLocal(req?.socket?.remoteAddress)) return false;
  const encaminhado = req?.headers?.["x-forwarded-for"];
  if (!encaminhado) return true;
  return enderecoLocal(String(encaminhado).split(",")[0]);
}
