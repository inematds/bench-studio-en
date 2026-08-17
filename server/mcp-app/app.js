import { App } from "@modelcontextprotocol/ext-apps";
import "./style.css";

const gallery = document.querySelector("#gallery");
const count = document.querySelector("#count");
const app = new App({ name: "Bench Studio results", version: "1.0.0" });

function money(value) {
  if (value == null) return "Cost pending";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
}

function linkButton(label, url, primary = false) {
  const button = document.createElement("button");
  button.className = primary ? "action primary" : "action";
  button.textContent = label;
  button.addEventListener("click", () => app.openLink({ url }));
  return button;
}

function render(payload) {
  const rows = payload?.rows ?? (payload?.outputs ? [payload] : []);
  gallery.replaceChildren();
  count.textContent = `${rows.length} ${rows.length === 1 ? "result" : "results"}`;

  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No generated assets yet.";
    gallery.append(empty);
    return;
  }

  for (const row of rows) {
    for (const output of row.outputs ?? []) {
      const card = document.createElement("article");
      card.className = "card";
      const frame = document.createElement("div");
      frame.className = "frame";
      const type = output.content_type || "";

      if (type.startsWith("video/")) {
        const video = document.createElement("video");
        video.src = output.local_url || output.remote_url || output.url;
        video.poster = output.preview_url || "";
        video.controls = true;
        video.playsInline = true;
        video.preload = "metadata";
        frame.append(video);
      } else if (type.startsWith("image/")) {
        const image = document.createElement("img");
        image.src = output.preview_url || output.local_url || output.remote_url || output.url;
        image.alt = row.prompt || row.label || "Generated asset";
        frame.append(image);
      }

      const details = document.createElement("div");
      details.className = "details";
      const copy = document.createElement("div");
      const title = document.createElement("h2");
      title.textContent = row.label || row.model || "Generated asset";
      const prompt = document.createElement("p");
      prompt.className = "prompt";
      prompt.textContent = row.raw_idea || row.prompt || "Generated in Bench Studio";
      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent = [row.kind, output.width && output.height ? `${output.width} × ${output.height}` : null, money(row.cost)].filter(Boolean).join(" · ");
      copy.append(title, prompt, meta);

      const actions = document.createElement("div");
      actions.className = "actions";
      const assetUrl = output.local_url || output.remote_url || output.url;
      if (assetUrl) actions.append(linkButton(type.startsWith("video/") ? "Open video" : "Open original", assetUrl, true));
      if (output.remote_url && output.remote_url !== assetUrl) actions.append(linkButton("Hosted copy", output.remote_url));
      details.append(copy, actions);
      card.append(frame, details);
      gallery.append(card);
    }
  }
}

app.ontoolresult = (result) => render(result.structuredContent);
app.connect();
