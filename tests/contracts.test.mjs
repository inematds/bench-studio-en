import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assignInputFields, retainCompatibleAssets, sortModels } from "../src/modelCatalog.js";

const registry = JSON.parse(readFileSync(new URL("../server/registry.json", import.meta.url)));
const capabilities = JSON.parse(readFileSync(new URL("../server/capabilities.json", import.meta.url)));
const capabilityById = new Map(capabilities.models.map((model) => [model.model_id, model]));
const models = registry.models.map((model) => ({ ...model, capabilities: capabilityById.get(model.id) }));

test("every production model has a unique id, output kind, lane, params, and capability contract", () => {
  assert.ok(models.length >= 30);
  assert.equal(new Set(models.map((model) => model.id)).size, models.length);
  for (const model of models) {
    assert.match(model.id, /^[a-z0-9][a-z0-9._/-]+$/i, model.id);
    assert.ok(["image", "video"].includes(model.kind), `${model.id}: invalid kind`);
    assert.ok(["t2i", "i2i", "t2v", "i2v", "r2v"].includes(model.lane), `${model.id}: invalid lane`);
    assert.equal(typeof model.params, "object", `${model.id}: missing params`);
    assert.ok(model.capabilities, `${model.id}: missing capability manifest`);
    assert.equal(model.capabilities.output, model.kind, `${model.id}: capability output drift`);
  }
});

test("declared capability fields are unique and internally consistent", () => {
  for (const model of models) {
    const inputs = model.capabilities.inputs ?? [];
    assert.equal(new Set(inputs.map((input) => input.field)).size, inputs.length, `${model.id}: duplicate input field`);
    for (const input of inputs) {
      assert.ok(["image", "video", "audio", "document", "mixed"].includes(input.modality), `${model.id}.${input.field}`);
      assert.ok(["single", "multiple"].includes(input.arity), `${model.id}.${input.field}`);
      if (input.limits?.max_items != null) assert.ok(input.limits.max_items >= 1);
    }
  }
});

test("image and video output switches always have a compatible default", () => {
  const reference = { media_type: "image", url: "https://example.invalid/ref.png", name: "ref.png" };
  for (const kind of ["image", "video"]) {
    assert.ok(sortModels(models.filter((model) => model.kind === kind))[0], `missing ${kind} default`);
    const compatible = sortModels(models.filter((model) => model.kind === kind && assignInputFields(model, [reference]).ok));
    assert.ok(compatible[0], `missing ${kind} default accepting image`);
    assert.equal(assignInputFields(compatible[0], [reference]).assets[0].media_type, "image");
  }
});

test("model changes retain compatible references and remove incompatible ones", () => {
  const image = { media_type: "image", url: "https://example.invalid/ref.png", name: "ref.png", field: "stale" };
  const compatibleModel = models.find((model) => model.capabilities.inputs?.some((input) => input.modality === "image"));
  const incompatibleModel = models.find((model) => !model.capabilities.inputs?.some((input) => input.modality === "image"));
  const retained = retainCompatibleAssets(compatibleModel, [image]);
  const removed = retainCompatibleAssets(incompatibleModel, [image]);
  assert.equal(retained.assets.length, 1);
  assert.notEqual(retained.assets[0].field, "stale");
  assert.equal(removed.assets.length, 0);
  assert.equal(removed.removed.length, 1);
});
