import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  assignInputFields,
  imageInputFor,
  mediaInputsFor,
  modelKindLabel,
  modelLaneLabel,
  modelPriority,
  sortModels,
} from "./modelCatalog.js";

// One bar, one action. Everything that changes the output is a chip inside it,
// including the model, so you never leave the thing you are typing in.

function prettyParam(name, value) {
  const raw = String(value);
  const named = {
    square_hd: "Square HD",
    square: "Square",
    portrait_4_3: "Portrait 4:3",
    portrait_16_9: "Portrait 16:9",
    landscape_4_3: "Landscape 4:3",
    landscape_16_9: "Landscape 16:9",
  };
  if (name === "image_size" && named[raw]) return named[raw];
  if (name === "duration") {
    if (raw.toLowerCase() === "auto") return "Auto";
    if (/^\d+(\.\d+)?s$/i.test(raw)) return raw;
    return `${raw} ${raw === "1" ? "second" : "seconds"}`;
  }
  if (name === "fps") return `${raw} fps`;
  if (name === "num_images") return `${raw} ${raw === "1" ? "image" : "images"}`;
  if (["generate_audio", "enable_prompt_expansion", "auto_fix"].includes(name)) {
    return raw === "true" ? "On" : raw === "false" ? "Off" : raw;
  }
  return raw
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function paramLabel(name) {
  const labels = {
    aspect_ratio: "Aspect ratio",
    duration: "Duration",
    resolution: "Resolution",
    image_size: "Image size",
    camera_motion: "Camera motion",
    shot_type: "Shot type",
    quality: "Quality",
    thinking_level: "Thinking level",
    fps: "Frame rate",
    num_images: "Number of images",
    generate_audio: "Generate audio",
    enable_prompt_expansion: "Prompt expansion",
    auto_fix: "Auto fix",
  };
  return labels[name] ?? prettyParam("", name);
}

export const SHOT_DIRECTION = {
  ugc: [
    {
      id: "creator",
      label: "Creator",
      options: [
        { value: "any creator", label: "Any creator" },
        { value: "a woman in her 20s", label: "Woman in her 20s" },
        { value: "a man in his 30s", label: "Man in his 30s" },
        { value: "a founder or expert", label: "Founder or expert" },
      ],
    },
    {
      id: "setting",
      label: "Setting",
      options: [
        { value: "a real home setting", label: "Real home" },
        { value: "a bathroom mirror", label: "Bathroom mirror" },
        { value: "a kitchen counter", label: "Kitchen counter" },
        { value: "the front seat of a car", label: "Car interior" },
      ],
    },
    {
      id: "beat",
      label: "Beat",
      options: [
        { value: "a problem, product proof, then a reaction", label: "Problem → proof → reaction" },
        { value: "a quick honest testimonial", label: "Quick testimonial" },
        { value: "a product demonstration with one clear result", label: "Product demonstration" },
        { value: "an unexpected first impression", label: "First impression" },
      ],
    },
    {
      id: "camera",
      label: "Camera",
      options: [
        { value: "a front-facing selfie camera", label: "Front-facing selfie" },
        { value: "a friend filming handheld", label: "Friend filming" },
        { value: "a close handheld product detail", label: "Close handheld" },
        { value: "a locked-off phone on a surface", label: "Phone on surface" },
      ],
    },
  ],
  unboxing: [
    {
      id: "view",
      label: "View",
      options: [
        { value: "top-down hands opening the package", label: "Top-down hands" },
        { value: "an over-the-shoulder unboxing", label: "Over the shoulder" },
        { value: "a close handheld reveal", label: "Close reveal" },
      ],
    },
    {
      id: "surface",
      label: "Surface",
      options: [
        { value: "a warm kitchen table", label: "Kitchen table" },
        { value: "a clean desk by a window", label: "Desk by a window" },
        { value: "a soft bedroom surface", label: "Bedroom surface" },
      ],
    },
    {
      id: "moment",
      label: "Moment",
      options: [
        { value: "the satisfying reveal of the product", label: "Satisfying reveal" },
        { value: "the first use straight from the box", label: "First use" },
        { value: "a close look at the packaging details", label: "Packaging details" },
      ],
    },
  ],
  hypermotion: [
    {
      id: "movement",
      label: "Movement",
      options: [
        { value: "a fast push-in with a sharp orbit", label: "Push-in + orbit" },
        { value: "a whip-pan between product details", label: "Whip-pan details" },
        { value: "a smooth floating macro move", label: "Floating macro" },
      ],
    },
    {
      id: "light",
      label: "Light",
      options: [
        { value: "a crisp electric blue rim light", label: "Electric blue rim" },
        { value: "hard studio light with deep shadows", label: "Hard studio light" },
        { value: "warm sunset light with bright highlights", label: "Warm highlights" },
      ],
    },
  ],
  tvspot: [
    {
      id: "camera",
      label: "Camera",
      options: [
        { value: "a locked-off hero composition", label: "Locked hero" },
        { value: "a slow, deliberate dolly forward", label: "Slow dolly" },
        { value: "a graceful product orbit", label: "Product orbit" },
      ],
    },
    {
      id: "mood",
      label: "Mood",
      options: [
        { value: "quiet, refined and confident", label: "Quiet + refined" },
        { value: "bold and high-contrast", label: "Bold + high contrast" },
        { value: "warm, optimistic and human", label: "Warm + human" },
      ],
    },
  ],
};

function ShotDirection({ format, values, onChange, customControls }) {
  // Modos de fabrica trazem os submodos daqui; os criados na aba Modes trazem
  // os deles pelo catalogo, ja no mesmo formato.
  const fields = SHOT_DIRECTION[format] ?? customControls ?? [];
  if (!fields.length) return null;

  return (
    <section className="shot-direction" aria-label="Shot direction">
      <div className="shot-direction-head">
        <div>
          <strong>Direct the shot</strong>
          <span>Optional choices that guide the rewrite</span>
        </div>
        <span className="shot-direction-mode">{format === "ugc" ? "UGC recipe" : "Creative recipe"}</span>
      </div>
      <div className="shot-direction-fields">
        {fields.map((field) => (
          <div className="shot-direction-field" key={field.id}>
            <span>{field.label}</span>
            <MenuSelect
              value={values[field.id] ?? field.options[0].value}
              options={field.options}
              ariaLabel={field.label}
              className="direction-menu"
              onChange={(value) => onChange({ ...values, [field.id]: value })}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function MenuSelect({ value, options, onChange, placeholder, ariaLabel, className = "" }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => String(option.value) === String(value)));
  const selected = options.find((option) => String(option.value) === String(value));

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  function toggle() {
    setActive(selectedIndex);
    setOpen((current) => !current);
  }

  function choose(option) {
    onChange(option.value);
    setOpen(false);
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => {
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        return (next + options.length) % options.length;
      });
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      choose(options[active]);
    }
  }

  return (
    <div ref={rootRef} className={`menu-select${open ? " open" : ""}${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="menu-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        <span>{selected?.label ?? placeholder}</span>
        <i className="menu-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="menu-popover" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={String(option.value) === String(value)}
              className={`menu-option${String(option.value) === String(value) ? " selected" : ""}${active === index ? " active" : ""}`}
              key={String(option.value)}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(option)}
            >
              <span>{option.label}</span>
              {String(option.value) === String(value) && <b aria-hidden="true">✓</b>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const PRICE_UNITS = {
  images: "image",
  megapixels: "megapixel",
  "processed megapixels": "processed megapixel",
  seconds: "second",
  "compute seconds": "compute second",
  units: "unit",
};

function modelPrice(model) {
  const pricing = model?.pricing;
  if (!pricing) return "Price unavailable";
  const amount = Number(pricing.price);
  const value = amount < 0.01
    ? amount.toFixed(5).replace(/0+$/, "").replace(/\.$/, "")
    : amount.toFixed(amount < 0.1 ? 3 : 2).replace(/0+$/, "").replace(/\.$/, "");
  return `$${value} / ${PRICE_UNITS[pricing.unit] ?? pricing.unit}`;
}

function ModelPicker({ model, models, onChange, referenceActive, refs = [] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [popoverStyle, setPopoverStyle] = useState(null);
  const [pinnedFilter, setPinnedFilter] = useState(() => {
    try { return localStorage.getItem("bench.model-filter-pinned") || ""; } catch { return ""; }
  });
  const [kindFilter, setKindFilter] = useState(() => {
    try {
      return localStorage.getItem("bench.model-filter-pinned") || localStorage.getItem("bench.model-filter") || "all";
    } catch { return "all"; }
  });
  const rootRef = useRef(null);
  const popoverRef = useRef(null);
  const searchRef = useRef(null);
  const normalizedQuery = query.trim().toLowerCase();
  const kindCounts = models.reduce((counts, candidate) => {
    counts[candidate.kind] = (counts[candidate.kind] ?? 0) + 1;
    return counts;
  }, {});
  const filteredModels = sortModels(models.filter((candidate) => {
    const matchesKind = normalizedQuery || kindFilter === "all" || candidate.kind === kindFilter;
    const matchesQuery = !normalizedQuery ||
      `${candidate.label} ${candidate.vendor} ${candidate.id} ${candidate.provider ?? ""} ${modelLaneLabel(candidate)}`.toLowerCase().includes(normalizedQuery);
    return matchesKind && matchesQuery;
  }));
  const popularModelId = filteredModels.find((candidate) => modelPriority(candidate) < 6)?.id;

  function measurePopover() {
    const trigger = rootRef.current?.getBoundingClientRect();
    if (!trigger) return null;
    const headerBottom = document.querySelector(".top")?.getBoundingClientRect().bottom ?? 0;
    const edge = 12;
    const gap = 8;
    const safeTop = headerBottom + 10;
    const width = Math.min(470, window.innerWidth - edge * 2);
    const availableAbove = Math.max(180, trigger.top - safeTop - gap);
    const availableBelow = Math.max(180, window.innerHeight - trigger.bottom - edge - gap);
    const useAbove = availableAbove >= availableBelow;
    return {
      left: Math.max(edge, Math.min(trigger.left, window.innerWidth - width - edge)),
      top: useAbove ? safeTop : trigger.bottom + gap,
      width,
      maxHeight: useAbove ? availableAbove : availableBelow,
    };
  }

  useEffect(() => {
    try { localStorage.setItem("bench.model-filter", kindFilter); } catch {}
  }, [kindFilter]);

  function chooseFilter(next) {
    setKindFilter(next);
    setQuery("");
    if (next === "all" || model.kind === next) return;

    const compatible = sortModels(models.filter((candidate) =>
      candidate.kind === next && (!refs.length || assignInputFields(candidate, refs).ok)
    ));
    if (compatible[0]) {
      onChange(compatible[0].id);
      setOpen(false);
    }
  }

  function togglePinnedFilter() {
    const next = pinnedFilter === kindFilter ? "" : kindFilter;
    setPinnedFilter(next);
    try {
      if (next) localStorage.setItem("bench.model-filter-pinned", next);
      else localStorage.removeItem("bench.model-filter-pinned");
    } catch {}
  }

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!rootRef.current?.contains(event.target) && !popoverRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    const placePopover = () => setPopoverStyle(measurePopover());
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", placePopover);
    document.querySelector(".scroll")?.addEventListener("scroll", placePopover, { passive: true });
    placePopover();
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", placePopover);
      document.querySelector(".scroll")?.removeEventListener("scroll", placePopover);
    };
  }, [open]);

  function choose(candidate) {
    onChange(candidate.id);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={rootRef} className={`model-picker${open ? " open" : ""}`}>
      <button
        type="button"
        className="model-picker-trigger"
        aria-label={`Change model, current ${model.label}, ${modelKindLabel(model)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => {
          if (!current) {
            setKindFilter(model.kind);
            setQuery("");
            setPopoverStyle(measurePopover());
          }
          return !current;
        })}
      >
        {model.thumbnail && <img src={model.thumbnail} alt="" />}
        <span className="model-picker-name">{model.label}</span>
        <span className="model-option-provider trigger">{model.provider ?? "fal"}</span>
        <span className={`model-picker-kind kind-${model.kind}${referenceActive ? " reference" : ""}`}>
          {referenceActive ? modelLaneLabel(model) : modelKindLabel(model)}
        </span>
        <i className="menu-chevron" aria-hidden="true" />
      </button>

      {open && createPortal((
        <div ref={popoverRef} className="model-picker-popover" style={popoverStyle ?? undefined}>
          <div className="model-picker-head">
            <div className="model-picker-head-copy">
              <strong>Choose a model</strong>
              <span>Start with the output type</span>
            </div>
            <div className="model-picker-head-actions">
              <span className="model-picker-count">{models.length} available</span>
              {kindFilter !== "all" && (
                <button
                  type="button"
                  className={`model-filter-pin${pinnedFilter === kindFilter ? " active" : ""}`}
                  aria-pressed={pinnedFilter === kindFilter}
                  onClick={togglePinnedFilter}
                  title={pinnedFilter === kindFilter ? "Remove this default" : `Open ${modelKindLabel({ kind: kindFilter })} models by default`}
                >
                  <i aria-hidden="true" />
                  {pinnedFilter === kindFilter ? "Default" : "Make default"}
                </button>
              )}
            </div>
          </div>
          <div className="model-kind-filter" role="group" aria-label="Filter models by output type">
            <span className="model-kind-filter-label">Output</span>
            <div className="model-kind-filter-options">
              {[
                { id: "all", label: "All", count: models.length },
                { id: "image", label: "Image", count: kindCounts.image ?? 0 },
                { id: "video", label: "Video", count: kindCounts.video ?? 0 },
              ].filter((filter) => filter.id === "all" || filter.count > 0).map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  className={`model-kind-filter-button${kindFilter === filter.id ? " active" : ""}`}
                  aria-pressed={kindFilter === filter.id}
                  aria-label={filter.id === "all" ? "Show all models" : `Switch output to ${filter.label}`}
                  onClick={() => chooseFilter(filter.id)}
                >
                  <span className={`model-kind-filter-mark ${filter.id}`} aria-hidden="true" />
                  <span className="model-kind-filter-name">{filter.label}</span>
                  <b>{filter.count}</b>
                </button>
              ))}
            </div>
          </div>
          <input
            ref={searchRef}
            className="model-search"
            type="search"
            value={query}
            placeholder="Search models"
            aria-label="Search models"
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="model-list" role="listbox" aria-label="Available models">
            {filteredModels.map((candidate) => (
              <button
                type="button"
                role="option"
                aria-selected={candidate.id === model.id}
                className={`model-option${candidate.id === model.id ? " selected" : ""}`}
                key={candidate.id}
                onClick={() => choose(candidate)}
              >
                {candidate.thumbnail ? (
                  <img src={candidate.thumbnail} alt="" />
                ) : (
                  <span className="model-option-placeholder" aria-hidden="true" />
                )}
                <span className="model-option-copy">
                  <b>
                    {candidate.label}
                    {/* A ROTA precisa aparecer aqui: o mesmo modelo existe em
                        mais de um provedor com cobranca diferente (Kling por
                        credito do plano, fal por dolar/segundo), e sem isto a
                        escolha entre eles vira adivinhacao. */}
                    <span className="model-option-provider">{candidate.provider ?? "fal"}</span>
                  </b>
                  <small>
                    {candidate.vendor} · {modelLaneLabel(candidate)} · {modelPrice(candidate)}
                    {candidate.capabilities?.modalities?.length ? ` · takes ${candidate.capabilities.modalities.join(" + ")}` : ""}
                  </small>
                </span>
                <span className="model-option-tail">
                  <span className={`model-option-kind kind-${candidate.kind}`}>{modelKindLabel(candidate)}</span>
                  {candidate.id === popularModelId && <em className="model-option-recommended">Popular</em>}
                  {candidate.tier === "fastest" && <em>Fast</em>}
                  {candidate.id === model.id && <strong aria-label="Selected">✓</strong>}
                </span>
              </button>
            ))}
            {!filteredModels.length && (
              <div className="model-empty">
                No {kindFilter === "all" ? "models" : `${kindFilter} models`} match “{query}”.
              </div>
            )}
          </div>
        </div>
      ), document.body)}
    </div>
  );
}

export default function PromptBar({
  catalog, model, idea, setIdea, format, setFormat,
  params, setParams, hide, refs, onAttach, onRemoveRef,
  rewritten, setRewritten, onOptimize, onGenerate,
  quote, busy, running, onPickModel, referenceModel, shotSettings, setShotSettings,
}) {
  const fileRef = useRef(null);
  const [openRewrite, setOpenRewrite] = useState(true);
  const [showDropzone, setShowDropzone] = useState(false);
  const [dragging, setDragging] = useState(false);

  if (!catalog || !model) {
    return (
      <div className="bar-wrap">
        <div className="bar-loading" aria-busy="true">
          <span className="loading-orb" aria-hidden="true" />
          <div>
            <strong>Connecting to the model catalog</strong>
            <span>Loading the controls for your first shot.</span>
          </div>
          <small>Just a moment</small>
        </div>
      </div>
    );
  }

  // Endpoints list their params in arbitrary order, so rank by what a person
  // actually reaches for. Without this, an interesting control like LTX's
  // camera_motion gets pushed off the bar by plumbing.
  const CHIP_ORDER = [
    "aspect_ratio", "duration", "resolution", "image_size", "camera_motion",
    "shot_type", "quality", "thinking_level", "fps", "num_images",
    "generate_audio", "enable_prompt_expansion", "auto_fix",
  ];
  const rank = (n) => {
    const i = CHIP_ORDER.indexOf(n);
    return i === -1 ? 99 : i;
  };

  const chipParams = Object.entries(model.params)
    .filter(([n, s]) => !hide.has(n) && s.enum?.length)
    .sort(([a], [b]) => rank(a) - rank(b))
    .slice(0, 5);

  const ready = Boolean((rewritten?.prompt ?? idea).trim());
  const rewriteWords = String(rewritten?.prompt ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const canAttach = Boolean(imageInputFor(model) || referenceModel);
  const directInputs = mediaInputsFor(model);
  const acceptedModalities = [...new Set(directInputs.map((input) => input.modality).filter((item) => item !== "mixed"))];
  if (!acceptedModalities.includes("image") && referenceModel) acceptedModalities.push("image");
  const canAttachMedia = acceptedModalities.length > 0;
  const accept = acceptedModalities.map((type) => ({
    image: "image/png,image/jpeg,image/webp,image/gif",
    video: "video/mp4,video/quicktime",
    audio: "audio/mpeg,audio/wav,audio/x-wav",
    document: "application/pdf",
  }[type])).filter(Boolean).join(",");
  const acceptedLabel = acceptedModalities.map((type) => type === "document" ? "PDF" : type).join(", ");
  const attachmentHint = directInputs.length === 0 && referenceModel
    ? `Attaching an image switches to ${referenceModel.label}`
    : acceptedLabel
    ? `This model accepts ${acceptedLabel}`
    : "Choose a compatible model first";
  const quickFormats = [
    { id: "ugc", label: "UGC ad" },
    { id: "none", label: "Freeform" },
    { id: "unboxing", label: "Unboxing" },
    { id: "product", label: "Product still" },
  ];
  const quickFormatIds = new Set(quickFormats.map(({ id }) => id));
  const otherFormats = (catalog.formats ?? []).filter(({ id }) => !quickFormatIds.has(id));
  const otherFormatOptions = otherFormats.map(({ id, label }) => ({ value: id, label }));

  async function addFiles(fileList) {
    const files = Array.from(fileList ?? []);
    for (const file of files) await onAttach(file);
  }

  return (
    <div className="bar-wrap">
      <div className="bar">
        <div className="preset-row" aria-label="Creation mode">
          <span className="preset-label">Mode</span>
          {quickFormats.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`preset${format === preset.id ? " on" : ""}`}
              onClick={() => setFormat(preset.id)}
            >
              {preset.label}
            </button>
          ))}
          {format === "ugc" && <span className="preset-detail">one creator / one beat / phone-native</span>}
          {otherFormats.length > 0 && (
            <div className={`preset-more${quickFormatIds.has(format) ? "" : " on"}`}>
              <MenuSelect
                value={quickFormatIds.has(format) ? "" : format}
                options={otherFormatOptions}
                placeholder="More modes"
                ariaLabel="More creation modes"
                onChange={setFormat}
              />
            </div>
          )}
        </div>

        <ShotDirection
          format={format}
          values={shotSettings}
          onChange={setShotSettings}
          customControls={(catalog.formats ?? []).find((f) => f.id === format && f.custom)?.controls}
        />

        <div className="bar-top">
          {refs.length > 0 && (
            <div className="attach-thumbs">
              {refs.map((r, i) => (
                <span className="attach-thumb-wrap" key={r.url}>
                  {r.media_type === "image" ? (
                    <img className="attach-thumb" src={r.preview} alt={r.name} />
                  ) : (
                    <span className={`attach-file attach-file-${r.media_type}`} title={r.name}>
                      <b>{r.media_type === "document" ? "PDF" : r.media_type}</b>
                      <small>{r.name}</small>
                    </span>
                  )}
                  <button
                    type="button"
                    className="attach-remove"
                    onClick={() => onRemoveRef(i)}
                    aria-label={`Remove ${r.name}`}
                    title="Remove reference"
                  >×</button>
                </span>
              ))}
            </div>
          )}

          {!showDropzone && (
            <button
              type="button"
              className="attach"
              onClick={() => setShowDropzone(true)}
              disabled={busy || !canAttachMedia}
              aria-expanded={false}
              aria-label="Add input media"
              title={
                imageInputFor(model)
                  ? `Attach a reference image using ${modelLaneLabel(model)}`
                  : referenceModel
                  ? `Attach a reference image, this switches to ${modelLaneLabel(referenceModel)}`
                  : "This model does not take a reference image"
              }
            >
              +
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />

          <textarea
            id="prompt-idea"
            name="prompt"
            value={idea}
            placeholder="Describe what you want to make..."
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                rewritten ? onGenerate() : onOptimize();
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onGenerate();
              }
            }}
          />

          <button type="button" className="go" onClick={rewritten ? onGenerate : onOptimize} disabled={busy || !ready}>
            {running ? "Running" : busy ? "Working" : rewritten ? "Generate" : "Refine prompt"}
          </button>
        </div>

        {showDropzone && (
          <div className="dropzone-wrap">
            <div
              className={`dropzone${dragging ? " dragging" : ""}`}
              role="button"
              tabIndex={canAttachMedia ? 0 : -1}
              aria-label="Add input media"
              aria-disabled={!canAttachMedia}
              onClick={() => {
                if (canAttachMedia && !busy) fileRef.current?.click();
              }}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && canAttachMedia && !busy) {
                  e.preventDefault();
                  fileRef.current?.click();
                }
              }}
              onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={(e) => {
                if (e.currentTarget === e.target) setDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                addFiles(e.dataTransfer.files);
              }}
            >
              <div className="dropzone-visual" aria-hidden="true">
                <span className="dropzone-card dropzone-card-back" />
                <span className="dropzone-card dropzone-card-front"><i /></span>
                <span className="dropzone-sweep" />
              </div>
              <div className="dropzone-copy">
                <strong>{dragging ? "Release to attach" : "Drop media here"}</strong>
                <span>{attachmentHint} · or click to browse</span>
              </div>
              {refs.length > 0 && (
                <span className="dropzone-count">
                  {refs.length} {refs.length === 1 ? "file" : "files"} attached · matched to {modelLaneLabel(model)}
                </span>
              )}
            </div>
            <button
              type="button"
              className="dropzone-close"
              aria-label="Close input media area"
              onClick={(e) => {
                e.stopPropagation();
                setShowDropzone(false);
                setDragging(false);
              }}
            >
              Close
            </button>
          </div>
        )}

        <div className="bar-chips">
          <ModelPicker
            model={model}
            // Curadoria vale aqui tambem, senao "desliguei 60 modelos" nao
            // muda nada onde o modelo e de fato escolhido. Indisponivel sai
            // igual: oferecer um modelo sem chave e oferecer um erro.
            models={catalog.models.filter((m) => m.enabled !== false && m.available !== false)}
            onChange={onPickModel}
            referenceActive={refs.length > 0}
            refs={refs}
          />

          {chipParams.map(([name, spec]) => (
            <span className="chip" key={name} title={spec.description}>
              <MenuSelect
                value={params[name] ?? spec.default ?? spec.enum[0]}
                options={spec.enum.map((o) => ({ value: String(o), label: prettyParam(name, o) }))}
                ariaLabel={paramLabel(name)}
                onChange={(value) => setParams((p) => ({ ...p, [name]: value }))}
              />
            </span>
          ))}

          {quote?.cost != null ? (
            <span className="bar-price exact" title={quote.basis}>
              <span>Estimated total</span>
              <b>${quote.cost.toFixed(3)}</b>
            </span>
          ) : quote?.confidence === "unquotable" ? (
            <span className="bar-price metered" title={quote.basis}>
              <span className="bar-price-label">Usage-based pricing</span>
              <span className="bar-price-rate">
                <strong>${quote.unit_price}</strong>
                <span>per {PRICE_UNITS[quote.unit] ?? quote.unit}</span>
              </span>
              <small>Exact total shown after generation</small>
            </span>
          ) : null}
        </div>
      </div>

      {rewritten && (
        <section className="rewrite" aria-label="Editable prompt draft">
          <div className="rewrite-head">
            <div className="rewrite-title">
              <strong>Prompt draft</strong>
              <span>
                {rewritten.optimized
                  ? `Tuned for ${model.label}`
                  : `Sent as written · ${rewritten.reason}`}
              </span>
            </div>
            <div className="rewrite-actions">
              <button type="button" className="rewrite-action" onClick={() => setRewritten(null)}>Discard</button>
              <button
                type="button"
                className="rewrite-action"
                aria-expanded={openRewrite}
                onClick={() => setOpenRewrite((v) => !v)}
              >
                {openRewrite ? "Hide" : "Edit draft"}
              </button>
            </div>
          </div>
          {openRewrite && (
            <div className="rewrite-body">
              <label htmlFor="rewritten-prompt">Edit the wording before you generate.</label>
              <textarea
                id="rewritten-prompt"
                name="rewritten-prompt"
                aria-label="Editable rewritten prompt"
                value={rewritten.prompt}
                onChange={(e) => setRewritten({ ...rewritten, prompt: e.target.value })}
              />
              <div className="rewrite-foot">
                <span>{rewriteWords} {rewriteWords === 1 ? "word" : "words"}</span>
                <span>Your edits are used for the next generation.</span>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
