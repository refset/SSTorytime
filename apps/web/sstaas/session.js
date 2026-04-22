// URL-as-session-id contract. Every tab gets a ?session=<id>. Two tabs
// with the same URL share the same local-folder binding in IndexedDB;
// two tabs with different session ids are fully independent.
//
// We deliberately do NOT share the PGlite database across tabs — it
// lives in memory per tab today. The session id is the stable name
// we key IndexedDB handle storage on, and (eventually) the persistent
// PGlite name once idb:// works.

const SESSION_PARAM = "session";

export function getSessionId() {
  const params = new URLSearchParams(window.location.search);
  let id = params.get(SESSION_PARAM);
  if (id && /^[A-Za-z0-9_-]{4,64}$/.test(id)) return id;

  id = generateSessionId();
  params.set(SESSION_PARAM, id);
  const url = window.location.pathname + "?" + params.toString() + window.location.hash;
  window.history.replaceState(window.history.state, "", url);
  return id;
}

function generateSessionId() {
  // 12 bytes base64url — short enough to eyeball, plenty of entropy.
  const buf = new Uint8Array(9);
  crypto.getRandomValues(buf);
  let s = btoa(String.fromCharCode(...buf));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
