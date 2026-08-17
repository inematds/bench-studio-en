---
name: bench-studio
description: Create and inspect images, videos, local websites, and designed PDF documents through Bench Studio. Use when a request involves choosing a fal model, mapping reference media to model-specific fields, generating media with transparent pricing, building a prompt-driven website or PDF through the cached Codex subscription, retrieving local artifacts, checking generation spend, or syncing the fal catalog.
---

# Bench Studio

Use Bench as a local creative operating system. Prefer its MCP tools; fall back to the loopback API at `http://localhost:8787` when the MCP server is not connected.

## Route the request

- Images or videos: inspect models, inspect the chosen model's inputs, upload any media, then generate.
- Websites: start `create_website`, retain the project id, poll `get_project`, and return the preview plus source artifact.
- Documents: start `create_document`, poll `get_project`, and return the PDF plus editable HTML preview.
- Existing work: use `list_results` for media or `list_projects` for websites and documents.
- Pricing or storage: use `get_usage` before making assumptions.

## Media workflow

1. Call `list_models` with the requested output and required input modality.
2. Call `get_model_capabilities` before attaching media. Treat `schema-supported` as declared support, not proof of visual fidelity.
3. Call `upload_media` for every local asset. Keep both its hosted URL and local archive URL.
4. Map each uploaded asset to an exact capability field. Never invent `image_url`; models differ.
5. Call `create_media` with the smallest suitable model and explicit parameters.
6. Return local result URLs first and hosted fal URLs second.

Do not say a reference influenced an output merely because fal accepted the field. Say “submitted successfully” unless an output was actually reviewed.

## Website and document workflow

Write a concrete creative brief containing audience, purpose, mood, required sections, and constraints. Pick `low` depth for routine drafts and `medium` for consequential work. Builds use the local ChatGPT-authenticated Codex SDK and create inspectable files under Bench's project archive.

Poll until `complete`, `failed`, or `cancelled`. Do not report a queued job as delivered. For PDFs, visually inspect representative rendered pages before calling the document finished when the user asks for a final production artifact.

## Safety and truthfulness

- Never copy or expose `~/.codex/auth.json`, fal keys, or other credentials. The SDK reads cached authentication itself.
- Never bypass a model's capability contract to force an attachment through.
- Prefer local media and project URLs; retain remote URLs for portability.
- Avoid high-cost generations when a frugal model can answer the brief.
- Explain whether cost is an estimate, metered rate, or actual billed total.

Read [references/interface.md](references/interface.md) when MCP tools are unavailable or when debugging the local service.
