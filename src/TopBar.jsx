import React from "react";

export default function TopBar({ summary, activeView, onLedger, ledgerOpen, billing, onCredits, creditsOpen, version, onConfig, configOpen }) {
  const month = summary?.month ?? 0;
  const all = summary?.all_time ?? 0;
  const gens = summary?.total_generations ?? 0;
  const navItem = (view, label, title) => (
    <a
      href={`#${view}`}
      className={activeView === view ? "active" : ""}
      aria-current={activeView === view ? "page" : undefined}
      title={title}
    >
      {label}
    </a>
  );

  return (
    <header className="top">
      <div className="brand">
        Bench
        <small>studio</small>
        {version && <span className="brand-version" title={`Bench Studio ${version}`}>v{version}</span>}
      </div>

      <nav className="top-nav" aria-label="Primary navigation">
        {navItem("create", "Create", "Create a new image or video")}
        {navItem("websites", "Websites", "Create a complete local website")}
        {navItem("documents", "Documents", "Create a designed PDF document")}
        {navItem("models", "Model catalog", "Browse available image and video models")}
        {navItem("work", "Results", "View your generated images and videos")}
        {navItem("modes", "Modes", "Create your own shot modes")}
        {navItem("connect", "Connect", "Use Bench from local AI tools")}
      </nav>

      <div className="top-spacer" />

      <div className="usage" title={`$${fmt(all)} all time`}>
        <span>Usage</span>
        <strong>${fmt(month)}</strong>
        <span>{gens} runs</span>
      </div>

      <button type="button" className={`credit-btn${creditsOpen ? " on" : ""}`} onClick={onCredits}>
        {billing?.available && billing.current_balance != null
          ? `${currency(billing.current_balance, billing.currency)} credits`
          : "Add credits"}
      </button>

      {/* Config fica no grupo da direita, com Usage e Ledger: e ferramenta de
          conta e de maquina, nao um workspace de trabalho como as abas. */}
      <button
        type="button"
        className={`ghost-btn${configOpen ? " on" : ""}`}
        onClick={onConfig}
        title="API keys, local models, and security"
      >
        Config
      </button>

      <button type="button" className={`ghost-btn${ledgerOpen ? " on" : ""}`} onClick={onLedger}>
        Ledger
      </button>
    </header>
  );
}

function currency(value, code = "USD") {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: code, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `$${Number(value).toFixed(2)}`;
  }
}

function fmt(n) {
  const v = Number(n) || 0;
  return v < 1 ? v.toFixed(3) : v.toFixed(2);
}
