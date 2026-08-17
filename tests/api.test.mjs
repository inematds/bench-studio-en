import test from "node:test";
import assert from "node:assert/strict";

const base = process.env.BENCH_API_URL || "http://localhost:8787";

async function json(path, options) {
  const response = await fetch(`${base}${path}`, options);
  const payload = await response.json();
  return { response, payload };
}

test("health, storage, catalog, capabilities, and archives agree", async () => {
  const [health, storage, catalog, capabilities, ledger, websites, documents] = await Promise.all([
    json("/api/health"), json("/api/storage"), json("/api/models"), json("/api/capabilities"),
    json("/api/ledger"), json("/api/projects?kind=website"), json("/api/projects?kind=document"),
  ]);
  for (const item of [health, storage, catalog, capabilities, ledger, websites, documents]) assert.equal(item.response.status, 200);
  assert.equal(health.payload.persistence, "sqlite");
  assert.equal(storage.payload.engine, "SQLite");
  assert.equal(health.payload.models, catalog.payload.models.length);
  assert.equal(capabilities.payload.models.length, catalog.payload.models.length);
  assert.equal(health.payload.storage.generations, ledger.payload.rows.length);
  assert.ok(Array.isArray(websites.payload.rows));
  assert.ok(Array.isArray(documents.payload.rows));
});

test("invalid generation and project requests fail safely and specifically", async () => {
  const unknown = await json("/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId: "not/a-model", prompt: "test" }) });
  assert.equal(unknown.response.status, 400);
  assert.match(unknown.payload.error, /unknown model/i);
  const project = await json("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "website", title: "", prompt: "short" }) });
  assert.equal(project.response.status, 400);
  assert.match(project.payload.error, /title/i);
  const missing = await json("/api/projects/missing-project");
  assert.equal(missing.response.status, 404);
  const missingResult = await json("/api/results/999999999", { method: "DELETE" });
  assert.equal(missingResult.response.status, 404);

  const noFile = await json("/api/upload", { method: "POST" });
  assert.equal(noFile.response.status, 400);
  assert.match(noFile.payload.error, /no file/i);

  const badSlot = await json("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      modelId: "fal-ai/flux-2/flash",
      prompt: "test",
      inputAssets: [{ url: "https://example.test/reference.png", field: "image_url", media_type: "image" }],
    }),
  });
  assert.equal(badSlot.response.status, 400);
  assert.match(badSlot.payload.error, /cannot use the attached image/i);
});
