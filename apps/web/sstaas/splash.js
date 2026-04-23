// Loading splash shown from the moment bootstrap.js begins to the
// moment PGlite + WASM + SST.OpenWasm finish. Hides the upstream SPA
// behind a solid overlay so the user isn't looking at a half-wired
// UI that can't answer searches yet.
//
// The pulsing dots are three spans cycling opacity with a staggered
// delay — purely CSS, no JS animation frames.

const SPLASH_HTML = `
<div id="sstaas-splash" role="status" aria-live="polite">
  <div id="sstaas-splash-card">
    <h1>SSTorytime</h1>
    <div id="sstaas-splash-dots" aria-hidden="true">
      <span></span><span></span><span></span>
    </div>
    <div id="sstaas-splash-msg">Starting PGlite + WASM runtime…</div>
  </div>
</div>`;

const SPLASH_STYLE = `
  #sstaas-splash {
    position: fixed; inset: 0; z-index: 99999;
    display: flex; align-items: center; justify-content: center;
    background: #f6f6f2; color: #222;
    font-family: system-ui, -apple-system, sans-serif;
    transition: opacity 0.25s ease;
  }
  #sstaas-splash.sstaas-splash-fade { opacity: 0; pointer-events: none; }
  #sstaas-splash-card {
    text-align: center; padding: 2rem 3rem;
  }
  #sstaas-splash-card h1 {
    font-size: 1.4rem; font-weight: 500; margin: 0 0 1.25rem;
    letter-spacing: 0.02em; color: #444;
  }
  #sstaas-splash-dots {
    display: inline-flex; gap: 0.5rem; margin-bottom: 0.9rem;
  }
  #sstaas-splash-dots span {
    display: inline-block; width: 0.6rem; height: 0.6rem;
    border-radius: 50%; background: #4a86c8;
    animation: sstaas-pulse 1.2s ease-in-out infinite;
  }
  #sstaas-splash-dots span:nth-child(2) { animation-delay: 0.2s; }
  #sstaas-splash-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes sstaas-pulse {
    0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); }
    40%           { opacity: 1;   transform: scale(1); }
  }
  #sstaas-splash-msg {
    font-size: 0.88rem; color: #666;
    min-height: 1.2em;
  }
  #sstaas-splash-msg.sstaas-splash-err { color: #b02020; font-weight: 500; }
`;

let splashEl = null;

export function showSplash() {
  if (splashEl) return;
  const styleEl = document.createElement("style");
  styleEl.id = "sstaas-splash-style";
  styleEl.textContent = SPLASH_STYLE;
  document.head.appendChild(styleEl);

  const wrap = document.createElement("div");
  wrap.innerHTML = SPLASH_HTML;
  splashEl = wrap.firstElementChild;
  document.body.appendChild(splashEl);
}

export function setSplashMessage(text, isError = false) {
  // Non-error status updates are swallowed on purpose — the splash
  // just reads "Starting PGlite + WASM runtime…" throughout. Errors
  // still come through so a failed bootstrap is visible.
  if (!isError) return;
  const msg = splashEl?.querySelector("#sstaas-splash-msg");
  if (!msg) return;
  msg.textContent = text;
  msg.classList.add("sstaas-splash-err");
}

export function hideSplash() {
  if (!splashEl) return;
  // Reveal the underlying UI before the fade starts so it's ready
  // behind the splash as opacity drops to zero.
  document.documentElement.classList.remove("sstaas-loading");
  splashEl.classList.add("sstaas-splash-fade");
  const el = splashEl;
  splashEl = null;
  setTimeout(() => el.remove(), 300);
}
