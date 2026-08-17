import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const BENCH_URL = process.env.BENCH_URL || "http://localhost:8787";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUTS_DIR = join(HERE, "..", "data", "outputs");
const PREVIEWS_DIR = join(HERE, "..", "data", "previews");
const RESULTS_APP_URI = "ui://bench-studio/results.html";
const RESULTS_APP_HTML = join(HERE, "mcp-app", "dist", "index.html");
const FFMPEG = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
let backendRecovery = null;
const MIME_BY_EXTENSION = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".pdf": "application/pdf",
};

async function waitForBackend() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${BENCH_URL}/api/storage`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Bench could not restart its local API. Open the Bench app and try again.");
}

async function recoverBackend() {
  if (backendRecovery) return backendRecovery;
  backendRecovery = (async () => {
    const child = spawn(process.execPath, [join(HERE, "server.mjs")], {
      cwd: join(HERE, ".."),
      env: process.env,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    await waitForBackend();
  })().finally(() => { backendRecovery = null; });
  return backendRecovery;
}

async function fetchBench(path, options) {
  try {
    return await fetch(`${BENCH_URL}${path}`, options);
  } catch {
    await recoverBackend();
    return fetch(`${BENCH_URL}${path}`, options);
  }
}

async function api(path, options) {
  const response = await fetchBench(path, options);
  const text = await response.text();
  if (!response.ok) {
    let message = text || `Bench HTTP ${response.status}`;
    try { message = JSON.parse(text).error || message; } catch {}
    throw new Error(message);
  }
  return text ? JSON.parse(text) : null;
}

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function localUrl(value) {
  if (!value || /^https?:\/\//i.test(value)) return value;
  return new URL(value, `${BENCH_URL}/`).href;
}

function mediaFile(output) {
  if (!output?.local_url) return null;
  try {
    const filename = basename(new URL(localUrl(output.local_url)).pathname);
    const path = join(OUTPUTS_DIR, filename);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

function mimeFor(path, fallback = "application/octet-stream") {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] || fallback;
}

function inlineImage(path, mimeType = mimeFor(path)) {
  if (!path || !existsSync(path) || statSync(path).size > MAX_INLINE_IMAGE_BYTES) return null;
  return { type: "image", data: readFileSync(path).toString("base64"), mimeType };
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${basename(command)} exited ${code}`)));
  });
}

async function videoPoster(path) {
  if (!path || !existsSync(path) || !existsSync(FFMPEG)) return null;
  mkdirSync(PREVIEWS_DIR, { recursive: true });
  const poster = join(PREVIEWS_DIR, `${basename(path, extname(path))}.jpg`);
  if (!existsSync(poster)) {
    try {
      await runProcess(FFMPEG, [
        "-y", "-ss", "0.5", "-i", path, "-frames:v", "1",
        "-vf", "scale=960:-2:force_original_aspect_ratio=decrease", "-q:v", "3", poster,
      ]);
    } catch {
      return null;
    }
  }
  return existsSync(poster) ? poster : null;
}

function normalizedRow(row) {
  return {
    ...row,
    outputs: (row.outputs ?? []).map((output) => ({
      ...output,
      local_url: localUrl(output.local_url),
    })),
  };
}

async function mediaResult(value, rows, previewLimit = 5) {
  const content = [{
    type: "text",
    text: "Presentation requirement: attach each preview_local_path as an image in the final answer using Claude's file attachment capability, so it renders inline. Then include the playable/download link. Do not reduce the result to a filename, Markdown text, or text-only URL.",
  }];
  let previewCount = 0;

  for (const row of rows) {
    for (const output of row.outputs ?? []) {
      if (previewCount >= previewLimit) break;
      const path = mediaFile(output);
      const mimeType = output.content_type || (path && mimeFor(path));
      const isImage = mimeType?.startsWith("image/");
      const isVideo = mimeType?.startsWith("video/");
      const previewPath = isImage ? path : isVideo ? await videoPoster(path) : null;
      const preview = previewPath ? inlineImage(previewPath, isImage ? mimeType : "image/jpeg") : null;
      const assetUrl = output.local_url || output.remote_url || output.url;
      const previewUrl = previewPath
        ? (isImage ? assetUrl : `${BENCH_URL}/previews/${encodeURIComponent(basename(previewPath))}`)
        : null;
      if (previewUrl) {
        output.preview_url = previewUrl;
        output.preview_local_path = previewPath;
      }

      content.push({
        type: "text",
        text: [
          `${row.label || row.model || "Generated asset"}${isVideo ? " — video preview" : ""}`,
          previewPath ? `Attach this image file inline: ${previewPath}` : null,
          previewUrl ? `Inline preview: ![${row.label || "Generated asset"}](${previewUrl})` : null,
          assetUrl ? `Playable/download link: ${assetUrl}` : null,
        ].filter(Boolean).join("\n"),
      });
      if (preview) content.push(preview);
      if (preview && previewUrl) {
        content.push({
          type: "resource",
          resource: {
            uri: previewUrl,
            mimeType: preview.mimeType,
            blob: preview.data,
          },
        });
      }
      if (assetUrl) {
        content.push({
          type: "resource_link",
          uri: assetUrl,
          name: basename(new URL(assetUrl).pathname) || "generated-asset",
          title: row.label || row.model || "Generated asset",
          description: isVideo ? "Open or download the playable video." : "Open or download the original asset.",
          mimeType: mimeType || "application/octet-stream",
        });
      }
      previewCount += 1;
    }
    if (previewCount >= previewLimit) break;
  }

  content.push({ type: "text", text: `Asset metadata:\n${JSON.stringify(value, null, 2)}` });
  return { content, structuredContent: value };
}

async function streamGeneration(body) {
  const response = await fetchBench("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text || `Generation HTTP ${response.status}`;
    try { message = JSON.parse(text).error || message; } catch {}
    throw new Error(message);
  }
  const events = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const error = events.findLast((event) => event.phase === "error");
  if (error) throw new Error(error.error);
  const done = events.findLast((event) => event.phase === "done");
  if (!done) throw new Error("Generation ended without a result");
  return done.ledger;
}

function buildServer() {
  const server = new McpServer({ name: "bench-studio", version: "0.3.0" }, { capabilities: { tools: {} } });

  server.registerTool("list_models", {
    title: "List media models",
    description: "List current fal image and video models with their accepted input media and pricing.",
    inputSchema: z.object({
      output: z.enum(["all", "image", "video"]).default("all"),
      accepts: z.enum(["any", "image", "video", "audio", "document"]).default("any"),
      search: z.string().optional(),
    }),
  }, async ({ output, accepts, search }) => {
    const catalog = await api("/api/models");
    const query = search?.toLowerCase();
    // A curadoria do catalogo vale aqui tambem: se o estudio nao oferece um
    // modelo, um agente conectado nao deveria ver uma lista diferente da que a
    // pessoa ve. Duas listas divergentes e como duas verdades.
    const models = catalog.models.filter((model) =>
      model.enabled !== false && model.available !== false &&
      (output === "all" || model.kind === output) &&
      (accepts === "any" || model.capabilities?.modalities?.includes(accepts)) &&
      (!query || `${model.label} ${model.vendor} ${model.id}`.toLowerCase().includes(query))
    ).map((model) => ({
      id: model.id, label: model.label, vendor: model.vendor, output: model.kind,
      lane: model.lane, inputs: model.capabilities?.inputs ?? [], pricing: model.pricing,
    }));
    return result({ count: models.length, models });
  });

  server.registerTool("get_model_capabilities", {
    title: "Inspect model inputs",
    description: "Return the schema-derived input contract and verification evidence for one model.",
    inputSchema: z.object({ model_id: z.string() }),
  }, async ({ model_id }) => {
    const manifest = await api("/api/capabilities");
    const model = manifest.models.find((candidate) => candidate.model_id === model_id);
    if (!model) throw new Error(`Unknown model ${model_id}`);
    return result({ ...model, checks: manifest.checks.filter((check) => check.model_id === model_id) });
  });

  server.registerTool("upload_media", {
    title: "Upload local media",
    description: "Copy a local image, video, audio file, or PDF into Bench and upload it to fal for use as model input.",
    inputSchema: z.object({ path: z.string() }),
  }, async ({ path }) => {
    const bytes = readFileSync(path);
    const form = new FormData();
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
    form.append("file", new Blob([bytes], { type: MIME_BY_EXTENSION[extension] || "application/octet-stream" }), basename(path));
    const response = await fetchBench("/api/upload", { method: "POST", body: form });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Upload HTTP ${response.status}`);
    return result(payload);
  });

  server.registerTool("create_media", {
    title: "Generate media",
    description: "Generate an image or video through Bench. Check model capabilities first and pass uploaded assets with exact input field names.",
    inputSchema: z.object({
      model_id: z.string(),
      prompt: z.string(),
      mode: z.string().default("none"),
      params: z.record(z.string(), z.unknown()).default({}),
      input_assets: z.array(z.object({
        url: z.string(), field: z.string(), media_type: z.enum(["image", "video", "audio", "document"]),
      })).default([]),
    }),
  }, async ({ model_id, prompt, mode, params, input_assets }) => {
    const row = normalizedRow(await streamGeneration({
      modelId: model_id, prompt, format: mode, params, inputAssets: input_assets,
    }));
    return mediaResult(row, [row], 1);
  });

  registerAppTool(server, "list_results", {
    title: "List generated results",
    description: "List recent generations with native inline previews, playable local asset links, and fal-hosted URLs.",
    _meta: { ui: { resourceUri: RESULTS_APP_URI } },
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).default(20),
      include_previews: z.boolean().default(true),
      preview_limit: z.number().int().min(1).max(10).default(5),
    }),
  }, async ({ limit, include_previews, preview_limit }) => {
    const ledger = await api("/api/ledger");
    const rows = ledger.rows.slice(0, limit).map(normalizedRow);
    const payload = { summary: ledger.summary, rows };
    return include_previews ? mediaResult(payload, rows, preview_limit) : result(payload);
  });

  registerAppResource(
    server,
    "Bench Studio results",
    RESULTS_APP_URI,
    { description: "An inline gallery with native image and video playback." },
    async () => ({
      contents: [{
        uri: RESULTS_APP_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: readFileSync(RESULTS_APP_HTML, "utf8"),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: {
              resourceDomains: [BENCH_URL],
              connectDomains: [BENCH_URL],
            },
          },
        },
      }],
    }),
  );

  server.registerTool("get_usage", {
    title: "Get generation usage",
    description: "Return actual recorded generation spend and local storage status.",
    inputSchema: z.object({}),
  }, async () => result({ usage: await api("/api/spend"), storage: await api("/api/storage") }));

  server.registerTool("sync_models", {
    title: "Sync fal model catalog",
    description: "Ask Bench to check fal for newly published image and video endpoints.",
    inputSchema: z.object({}),
  }, async () => result(await api("/api/catalog/sync", { method: "POST" })));

  for (const kind of ["website", "document"]) {
    server.registerTool(`create_${kind}`, {
      title: kind === "website" ? "Create a website" : "Create a PDF document",
      description: `Start a local Codex-powered ${kind} build. Uses cached ChatGPT authentication rather than an API key.`,
      inputSchema: z.object({
        title: z.string(),
        brief: z.string(),
        direction: z.string().optional(),
        depth: z.enum(["low", "medium"]).default("low"),
      }),
    }, async ({ title, brief, direction, depth }) => result(await api("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, title, prompt: brief, template: direction, model: "gpt-5.6-sol", reasoning: depth }),
    })));
  }

  server.registerTool("list_projects", {
    title: "List creative projects",
    description: "List locally generated websites and documents with build state and artifact URLs.",
    inputSchema: z.object({ kind: z.enum(["all", "website", "document"]).default("all") }),
  }, async ({ kind }) => result(await api(`/api/projects${kind === "all" ? "" : `?kind=${kind}`}`)));

  server.registerTool("get_project", {
    title: "Get a creative project",
    description: "Check build progress and retrieve preview or download URLs for a website or document.",
    inputSchema: z.object({ project_id: z.string() }),
  }, async ({ project_id }) => result(await api(`/api/projects/${encodeURIComponent(project_id)}`)));

  return server;
}

serveStdio(() => buildServer(), { onerror: (error) => console.error(error) });
