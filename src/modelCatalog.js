export const MODEL_KIND_LABELS = {
  image: "Image",
  video: "Video",
};

export const MODEL_LANE_LABELS = {
  t2i: "Text to image",
  i2i: "Edit an image",
  t2v: "Text to video",
  i2v: "Image to video",
  r2v: "Reference to video",
};

// A small editorial order for the first screen of the picker. This is not a
// performance claim; it puts the most useful starting points for ad work first
// and leaves the full catalog one search away.
export const MODEL_PRIORITY = [
  "fal-ai/veo3.1/fast",
  "fal-ai/kling-video/v3/pro/text-to-video",
  "bytedance/seedance-2.5/text-to-video",
  "fal-ai/veo3.1",
  "fal-ai/kling-video/v3/turbo/standard/text-to-video",
  "lightricks/ltx-2.5/text-to-video/fast",
  "fal-ai/nano-banana-pro",
  "openai/gpt-image-2",
  "fal-ai/flux-2-pro",
  "fal-ai/flux-2/flash",
  "bytedance/seedream/v5/pro/text-to-image",
  "fal-ai/nano-banana-2",
];

export function modelKindLabel(model) {
  return MODEL_KIND_LABELS[model?.kind] ?? "Model";
}

export function modelLaneLabel(model) {
  return MODEL_LANE_LABELS[model?.lane] ?? "General generation";
}

// These two fields are generated from the endpoint's live OpenAPI schema. A
// `pair` is only a navigation hint; it is never enough to prove that a model
// accepts an image.
export function imageInputFor(model) {
  if (model?.capabilities?.primary_image_field) {
    return {
      field: model.capabilities.primary_image_field,
      arity: model.capabilities.image_arity ?? "single",
    };
  }
  if (model?.image_input?.name && model.image_input.arity) {
    return { field: model.image_input.name, arity: model.image_input.arity };
  }
  if (!model?.image_param || !model?.accepts_image) return null;
  return { field: model.image_param, arity: model.accepts_image };
}

export function mediaInputsFor(model, modality) {
  const inputs = model?.capabilities?.inputs ?? [];
  return modality ? inputs.filter((input) => input.modality === modality || input.modality === "mixed") : inputs;
}

export function mediaTypeForFile(file) {
  if (file?.type?.startsWith("image/")) return "image";
  if (file?.type?.startsWith("video/")) return "video";
  if (file?.type?.startsWith("audio/")) return "audio";
  if (file?.type === "application/pdf" || /\.pdf$/i.test(file?.name ?? "")) return "document";
  return "file";
}

export function assignInputFields(model, assets) {
  const usage = new Map();
  const assigned = [];
  for (const asset of assets) {
    const candidates = mediaInputsFor(model, asset.media_type).sort((a, b) => {
      if (a.field === model?.capabilities?.primary_image_field) return -1;
      if (b.field === model?.capabilities?.primary_image_field) return 1;
      if (a.arity === "multiple" && b.arity !== "multiple") return -1;
      if (b.arity === "multiple" && a.arity !== "multiple") return 1;
      return 0;
    });
    const chosen = candidates.find((input) => {
      const count = usage.get(input.field) ?? 0;
      if (input.arity === "single") return count === 0;
      return !input.limits?.max_items || count < input.limits.max_items;
    });
    if (!chosen) return { ok: false, asset, reason: `${model?.label ?? "This model"} has no available ${asset.media_type} input.` };
    usage.set(chosen.field, (usage.get(chosen.field) ?? 0) + 1);
    assigned.push({ ...asset, field: chosen.field });
  }
  return { ok: true, assets: assigned };
}

// Model selection should never feel broken because an old attachment no
// longer fits. Keep every asset the new endpoint can accept, remap its field,
// and return the remainder so the UI can explain what was removed.
export function retainCompatibleAssets(model, assets) {
  let compatible = [];
  const removed = [];
  for (const asset of assets) {
    const assignment = assignInputFields(model, [...compatible, asset]);
    if (assignment.ok) compatible = assignment.assets;
    else removed.push(asset);
  }
  return { assets: compatible, removed };
}

export function pairedImageModel(models, model) {
  const paired = models?.find((candidate) => candidate.id === model?.pair);
  return imageInputFor(paired) ? paired : null;
}

export function modelPriority(model) {
  const exact = MODEL_PRIORITY.indexOf(model.id);
  if (exact !== -1) return exact;

  // Keep reference/image-to-video siblings near their parent model, while
  // keeping the catalog deterministic when new endpoints arrive.
  const family = MODEL_PRIORITY.findIndex((id) => {
    const stem = id.split("/").slice(0, 3).join("/");
    return model.id.startsWith(stem);
  });
  if (family !== -1) return family + 0.4;
  if (model.tier === "fastest") return 30;
  return 100 + (model.kind === "video" ? 1 : 0);
}

export function sortModels(models) {
  return [...models].sort((a, b) => {
    const priority = modelPriority(a) - modelPriority(b);
    if (priority !== 0) return priority;
    return a.label.localeCompare(b.label);
  });
}
