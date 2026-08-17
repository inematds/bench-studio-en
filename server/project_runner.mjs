import { ENGINES } from "./project_engines.mjs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectTextOverflow } from "./pdf_preflight.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const requestPath = resolve(process.argv[2] ?? "");
if (!requestPath || !existsSync(requestPath)) throw new Error("A valid project request file is required.");
const request = JSON.parse(await readFile(requestPath, "utf8"));
const outputDir = resolve(request.output_dir);
await mkdir(outputDir, { recursive: true });

function stage(progress, message) {
  console.log(`BENCH_STAGE:${progress}:${message}`);
}

// O caminho estava fixo no do macOS, então a geração de PDF nunca funcionaria
// fora de um Mac — e este estúdio roda em Linux. Procura os nomes usuais e
// permite apontar explicitamente com BENCH_CHROME.
function findChrome() {
  const candidates = [
    process.env.BENCH_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Chrome/Chromium não encontrado. Instale um, ou aponte BENCH_CHROME. Procurei em: ${candidates.join(", ")}`);
  return found;
}

function chromePrint(htmlPath, pdfPath) {
  const chrome = findChrome();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(chrome, [
      "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr || `Chrome exited ${code}`)));
  });
}

const isWebsite = request.kind === "website";
const reference = request.reference_path && existsSync(request.reference_path)
  ? `You may inspect this local reference for craft and interaction ideas: ${request.reference_path}. Do not copy its brand, text, structure, or assets.`
  : "";
const requiredFiles = isWebsite
  ? "Create index.html, styles.css, and app.js. Everything must run as a static site with no build step and no external network dependency."
  : "Create document.html as a complete print-ready A4 document. Use CSS @page, explicit page sections, and local/system fonts only. Every text block must fit its column: use min-width:0 in grids, size display type to its actual measure, and use overflow-wrap as a safety net. No heading, label, or paragraph may have scrollWidth greater than clientWidth.";

const isRevision = request.mode === "revise" && String(request.instruction ?? "").trim();

// Revisão é diferente de construção: já existe um resultado bom o bastante para
// a pessoa querer mexer nele, e o pedido dela é cirúrgico. O maior risco aqui
// não é gerar pouco, é reescrever tudo e perder o que já estava certo.
const revisionPrompt = `You are editing an EXISTING ${isWebsite ? "website" : "document"} inside Bench Studio, in the current working directory.

REQUESTED CHANGE (from the person who owns this project, may be in Portuguese):
${request.instruction}

RULES
- Apply ONLY what was asked. Everything not mentioned must stay exactly as it is.
- Preserve the existing art direction, structure, copy, class names and file names unless the request explicitly asks to change them.
- Never delete a file. Never rename a file. Never introduce a new external dependency.
- If the request is ambiguous, choose the smallest change that satisfies it.
- ${isWebsite ? "Keep index.html, styles.css and app.js consistent with each other: if you add markup that the CSS hides until revealed, make sure the JS reveals it." : "Keep the document print-safe: every text block must still fit its column."}
- Do not read credentials, touch files outside this project, browse the web, install packages, or call external APIs.

When complete, reply with a short factual summary of what changed.`;

const buildPrompt = `You are the production engine inside Bench Studio. Build a polished ${isWebsite ? "website" : "PDF document"} directly in the current working directory.

This is a bounded build. Do not read skills, search for additional instructions, or attempt to render the PDF yourself. Bench owns final rendering and visual QA after your turn. Inspect only the named craft reference and the files you create here.

PROJECT
Title: ${request.title}
Brief: ${request.prompt}
Direction: ${request.template}
${reference}

REQUIREMENTS
- ${requiredFiles}
- Make the result original, art-directed, readable, responsive where applicable, and ready to show a client.
- Do not use placeholder copy, lorem ipsum, fake testimonials, fake metrics, or stock-image URLs.
- Use a coherent type scale and one restrained accent system.
- Avoid generic AI gradients, excessive pills, glass cards, cute microcopy, and repetitive equal-card layouts.
- If imagery was not supplied, use intentional typography, CSS geometry, canvas, gradients, and procedural visual treatments instead of broken image placeholders.
- ${isWebsite ? "Include meaningful interaction and motion, with prefers-reduced-motion support. A 3D or spatial direction may use native Canvas/WebGL or CSS perspective." : "Write substantive content from the brief. Keep every page visually composed. Never use background-clip:text because Chrome print can replace the glyph mask with a gradient box."}
- Do not read credentials, touch files outside this project, browse the web, install packages, or call external APIs.
- Inspect your finished files and fix obvious visual, semantic, and accessibility defects before stopping.

When complete, reply with a short factual summary. The files, not the reply, are the deliverable.`;

const prompt = isRevision ? revisionPrompt : buildPrompt;

stage(8, isRevision ? "Lendo os arquivos atuais" : "Preparing the creative brief");
const eventsPath = join(outputDir, "codex-events.jsonl");
if (!isRevision) await writeFile(eventsPath, "");

const engineName = request.engine || "codex";
const engine = ENGINES[engineName];
if (!engine) throw new Error(`Motor desconhecido: ${engineName}. Disponíveis: ${Object.keys(ENGINES).join(", ")}`);
await engine.run({ prompt, outputDir, request, stage, eventsPath, isWebsite, isRevision });

if (isWebsite) {
  const entry = join(outputDir, "index.html");
  if (!existsSync(entry)) throw new Error("The website build did not create index.html");
  stage(92, "Website files are ready");
  await writeFile(join(outputDir, "result.json"), JSON.stringify({ entry_file: entry, artifact_file: entry }, null, 2));
} else {
  const entry = join(outputDir, "document.html");
  const pdf = join(outputDir, `${request.slug || "document"}.pdf`);
  if (!existsSync(entry)) throw new Error("The document build did not create document.html");
  stage(78, "Rendering the print edition");
  const overflow = await inspectTextOverflow(entry);
  if (overflow.length) {
    const summary = overflow.slice(0, 5).map((item) => `${item.element}: “${item.text}”`).join("; ");
    throw new Error(`Print preflight found overflowing text. ${summary}`);
  }
  await chromePrint(entry, pdf);
  if (!existsSync(pdf)) throw new Error("Chrome did not produce the PDF");
  stage(92, "PDF rendered and archived");
  await writeFile(join(outputDir, "result.json"), JSON.stringify({ entry_file: entry, artifact_file: pdf }, null, 2));
}
stage(100, "Complete");
