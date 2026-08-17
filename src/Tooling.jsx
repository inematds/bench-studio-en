import React, { useEffect, useMemo, useState } from "react";

export default function Tooling() {
  const [config, setConfig] = useState(null);
  const [copied, setCopied] = useState(false);
  const [client, setClient] = useState("claude");

  useEffect(() => {
    fetch("/api/tooling").then((response) => response.json()).then(setConfig).catch(() => {});
  }, []);

  const snippet = useMemo(() => {
    if (!config) return "Loading local configuration…";
    if (client === "codex") {
      return [
        "[mcp_servers.bench-studio]",
        `command = ${JSON.stringify(config.command)}`,
        `args = ${JSON.stringify(config.args)}`,
        "",
        "[mcp_servers.bench-studio.env]",
        `BENCH_URL = ${JSON.stringify(config.environment.BENCH_URL)}`,
      ].join("\n");
    }
    return JSON.stringify({
      mcpServers: {
        "bench-studio": {
          command: config.command,
          args: config.args,
          env: config.environment,
        },
      },
    }, null, 2);
  }, [client, config]);

  async function copy() {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <section className="connect-page">
      <div className="connect-hero">
        <div>
          <div className="eyebrow">Local tools</div>
          <h1>Use Bench from any agent.</h1>
          <p>Claude, Codex, and Cursor can use the same model catalog, input rules, generation pipeline, costs, and local archive as this app.</p>
        </div>
        <span className="local-pill"><i /> Runs on this Mac</span>
      </div>

      <div className="connect-grid">
        <article className="connect-card connect-skill">
          <div className="connect-card-head">
            <div><span>01</span><h2>Install the Bench skill</h2></div>
            <a className="connect-primary-action" href={config?.skill?.download_url ?? "/api/tooling/skill"} download>Download ZIP</a>
          </div>
          <p>Give Codex or Claude Code the workflow: model selection, reference handling, cost discipline, and local artifact rules.</p>
          <div className="skill-package">
            <div className="skill-package-mark" aria-hidden="true"><i /><i /><i /></div>
            <div><strong>Bench Studio skill</strong><span>Portable · no credentials included</span></div>
            <small>v{config?.skill?.version ?? "0.2.0"}</small>
          </div>
          <p className="install-path">Unzip into <code>{client === "codex" ? (config?.skill?.installs?.codex ?? "~/.codex/skills/bench-studio") : (config?.skill?.installs?.claude_code ?? "~/.claude/skills/bench-studio")}</code></p>
        </article>

        <article className="connect-card connect-config">
          <div className="connect-card-head">
            <div><span>02</span><h2>Connect the live tools</h2></div>
            <button type="button" onClick={copy}>{copied ? "Copied" : "Copy config"}</button>
          </div>
          <p>The MCP server provides feature parity with this app. Bench stays available as a local background service; paste the config, then restart your client once.</p>
          <div className="client-switch" role="tablist" aria-label="MCP client">
            <button type="button" role="tab" aria-selected={client === "claude"} className={client === "claude" ? "active" : ""} onClick={() => setClient("claude")}>Claude Desktop</button>
            <button type="button" role="tab" aria-selected={client === "codex"} className={client === "codex" ? "active" : ""} onClick={() => setClient("codex")}>Codex</button>
            <button type="button" role="tab" aria-selected={client === "cursor"} className={client === "cursor" ? "active" : ""} onClick={() => setClient("cursor")}>Cursor</button>
          </div>
          <pre tabIndex="0" aria-label={`${client === "codex" ? "Codex" : client === "cursor" ? "Cursor" : "Claude Desktop"} MCP configuration`}><code>{snippet}</code></pre>
        </article>

        <article className="connect-card">
          <div className="connect-card-head"><div><span>03</span><h2>Ask naturally</h2></div></div>
          <p className="example-prompt">“Find a frugal video model that accepts two product images, generate a 9:16 UGC ad, and save the result locally.”</p>
          <div className="connect-note">Skill = judgment and workflow. MCP = live catalog, generation, projects, results, and spend.</div>
        </article>
      </div>

      <section className="tool-list-section">
        <div className="tool-list-head">
          <div><h2>Full creation surface</h2><p>Eleven focused tools, backed by the same SQLite ledger and capability manifest as the app.</p></div>
          <span>{config?.tools?.length ?? 11} tools</span>
        </div>
        <div className="tool-list">
          {[
            ["list_models", "Discover current image and video models by output and accepted input."],
            ["get_model_capabilities", "Inspect exact media fields, limits, and verification evidence."],
            ["upload_media", "Archive a local file and prepare its fal-hosted input URL."],
            ["create_media", "Generate with precise model parameters and mapped input assets."],
            ["list_results", "Read recent outputs with both local and hosted URLs."],
            ["get_usage", "Review billed spend and local archive health."],
            ["sync_models", "Check fal for newly published endpoints."],
            ["create_website", "Start a complete local website build from a creative brief."],
            ["create_document", "Create an editable, print-ready PDF edition."],
            ["list_projects", "Browse local website and document projects."],
            ["get_project", "Check live build progress and retrieve artifacts."],
          ].map(([name, description]) => (
            <article key={name}><code>{name}</code><p>{description}</p></article>
          ))}
        </div>
      </section>
    </section>
  );
}
