import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../server/db.mjs";

test("SQLite persists generations, assets, spend, and projects across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-db-"));
  const dbPath = join(dir, "bench.db");
  const ledger = join(dir, "ledger.jsonl");
  writeFileSync(ledger, "");
  const row = {
    request_id: "req-test", ts: "2026-08-12T12:00:00.000Z", model: "model/test", label: "Test model",
    kind: "image", cost: 0.125, cost_confidence: "verified", outputs: [{ url: "https://example.invalid/a.png", local_url: "/media/a.png", content_type: "image/png" }],
  };
  let store = createStore({ dbPath, legacyLedgerPath: ledger });
  store.addGeneration(row);
  store.createProject({ id: "project-test", kind: "document", title: "Test", prompt: "A sufficiently detailed test project prompt.", status: "queued", stage: "Queued", progress: 0, output_dir: join(dir, "project"), created_at: row.ts, updated_at: row.ts });
  store.updateProject("project-test", { status: "complete", progress: 100, artifact_file: "/projects/test.pdf" });
  assert.equal(store.storageSummary().mirrored_outputs, 1);
  store.close();

  store = createStore({ dbPath, legacyLedgerPath: ledger });
  const saved = store.listGenerations()[0];
  assert.equal(saved.outputs[0].local_url, "/media/a.png");
  assert.equal(store.spendSummary().all_time, 0.125);
  assert.equal(store.getProject("project-test").status, "complete");
  assert.equal(store.getProject("project-test").artifact_file, "/projects/test.pdf");
  const removed = store.deleteGeneration(saved.archive_id);
  assert.equal(removed.request_id, "req-test");
  assert.equal(store.listGenerations().length, 0);
  assert.equal(store.spendSummary().all_time, 0);
  assert.equal(store.deleteGeneration(saved.archive_id), null);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("legacy migration is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-legacy-"));
  const dbPath = join(dir, "bench.db");
  const ledger = join(dir, "ledger.jsonl");
  writeFileSync(ledger, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", model: "legacy", outputs: [] })}\n`);
  const store = createStore({ dbPath, legacyLedgerPath: ledger });
  assert.equal(store.migrateLegacyLedger(), 1);
  assert.equal(store.migrateLegacyLedger(), 0);
  assert.equal(store.listGenerations().length, 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
