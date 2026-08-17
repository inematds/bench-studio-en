import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const smokeData = mkdtempSync(join(tmpdir(), "bench-studio-smoke-"));
const smokePort = 19_000 + (process.pid % 1_000);
const smokeUrl = `http://127.0.0.1:${smokePort}`;
const backend = spawn(process.execPath, [join(HERE, "server.mjs")], {
  env: {
    ...process.env,
    FAL_KEY: "smoke-test-placeholder",
    PORT: String(smokePort),
    BENCH_DATA_DIR: smokeData,
  },
  stdio: ["ignore", "ignore", "inherit"],
});

async function waitForBackend() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${smokeUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Bench smoke backend did not start at ${smokeUrl}`);
}

await waitForBackend();
const child = spawn(process.execPath, [join(HERE, "mcp.mjs")], {
  env: { ...process.env, BENCH_URL: smokeUrl },
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 10_000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

try {
  const initialized = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bench-smoke-test", version: "1.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const listed = await request(2, "tools/list");
  const usage = await request(3, "tools/call", { name: "get_usage", arguments: {} });
  const recent = await request(4, "tools/call", { name: "list_results", arguments: { limit: 1 } });
  const resultView = await request(5, "resources/read", { uri: "ui://bench-studio/results.html" });
  const toolNames = listed.tools.map((tool) => tool.name);
  if (toolNames.length !== 11 || !toolNames.includes("create_media") || !toolNames.includes("create_document")) {
    throw new Error(`Unexpected tool surface: ${toolNames.join(", ")}`);
  }
  if (usage.isError) throw new Error("get_usage returned an MCP error");
  if (recent.isError) throw new Error("list_results returned an MCP error");
  const resultTool = listed.tools.find((tool) => tool.name === "list_results");
  if (resultTool?._meta?.ui?.resourceUri !== "ui://bench-studio/results.html") {
    throw new Error("list_results is missing its MCP App resource metadata");
  }
  if (resultView.contents?.[0]?.mimeType !== "text/html;profile=mcp-app" || !resultView.contents?.[0]?.text?.includes("Latest work")) {
    throw new Error("Bench results MCP App resource is unavailable");
  }
  const recentPayload = recent.structuredContent;
  const localUrl = recentPayload?.rows?.[0]?.outputs?.[0]?.local_url;
  if (localUrl && !localUrl.startsWith("http://localhost:")) throw new Error(`list_results returned a relative local URL: ${localUrl}`);
  if (localUrl && !recent.content?.some((block) => block.type === "resource_link")) {
    throw new Error("list_results did not return a native resource link");
  }
  const latestMime = recentPayload?.rows?.[0]?.outputs?.[0]?.content_type;
  if ((latestMime?.startsWith("image/") || latestMime?.startsWith("video/")) && !recent.content?.some((block) => block.type === "image")) {
    throw new Error("list_results did not return an inline visual preview");
  }
  if ((latestMime?.startsWith("image/") || latestMime?.startsWith("video/")) && !recentPayload?.rows?.[0]?.outputs?.[0]?.preview_local_path) {
    throw new Error("list_results did not return an attachable preview path");
  }
  if ((latestMime?.startsWith("image/") || latestMime?.startsWith("video/")) && !recent.content?.some((block) => block.type === "resource" && block.resource?.blob)) {
    throw new Error("list_results did not return an embedded preview resource");
  }
  console.log(`MCP ${initialized.serverInfo.name} ${initialized.serverInfo.version}: ${toolNames.length} tools; usage, absolute URLs, and inline media passed`);
} finally {
  child.kill("SIGTERM");
  backend.kill("SIGTERM");
  rmSync(smokeData, { recursive: true, force: true });
}
