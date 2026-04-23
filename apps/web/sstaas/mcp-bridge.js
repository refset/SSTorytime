// MCP hub bridge. Opens a WebSocket to a local MCP-SST server
// (https://github.com/refset/MCP-SST) so Claude Code can drive this
// SPA's search over JSON-RPC. Explicit opt-in — the toggle + URL
// live in the controls bar; nothing connects until the user asks.
//
// Wire protocol (matches hub.go):
//   SPA → server    {type:"hello",  sessionId, target?}
//   SPA → server    {type:"target", target}
//   SPA → server    {type:"response", requestId, payload? | error?}
//   server → SPA    {type:"request", requestId, method, payload}
//
// We reply to every request with a "response" so the hub's pending-
// call channel resolves. Errors are reported in the "error" field.

import { getSessionId } from "./session.js";
import { wasmSearch } from "./bridge.js";

let ws = null;
let url = null;
let reconnectTimer = null;
let wantConnected = false;
const RECONNECT_MS = 5000;
const listeners = new Set();
let currentTarget = null;

function scheduleReconnect() {
  if (!wantConnected || reconnectTimer || ws) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (wantConnected && !ws && url) openSocket();
  }, RECONNECT_MS);
}

function emit(status, detail = {}) {
  for (const fn of listeners) {
    try { fn({ status, url, ...detail }); }
    catch (e) { console.error("mcp listener:", e); }
  }
}

export function onStatusChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function status() {
  if (!ws) return "disconnected";
  switch (ws.readyState) {
    case WebSocket.CONNECTING: return "connecting";
    case WebSocket.OPEN:       return "connected";
    case WebSocket.CLOSING:    return "closing";
    default:                   return "disconnected";
  }
}

export function connect(targetUrl, { target } = {}) {
  teardownSocket();
  url = targetUrl;
  currentTarget = target ?? currentTarget;
  wantConnected = true;
  openSocket();
}

function openSocket() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  let sock;
  try {
    sock = new WebSocket(url);
  } catch (err) {
    emit("error", { error: err.message });
    scheduleReconnect();
    return;
  }
  ws = sock;
  emit("connecting");

  sock.addEventListener("open", () => {
    if (sock !== ws) return;
    sock.send(JSON.stringify({
      type: "hello",
      sessionId: getSessionId(),
      target: currentTarget,
    }));
    emit("connected");
  });

  sock.addEventListener("message", async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch (e) { console.warn("mcp: bad JSON frame", ev.data); return; }
    if (msg.type !== "request") return;
    const { requestId, method, payload } = msg;
    try {
      const result = await dispatch(method, payload ?? {});
      sock.send(JSON.stringify({ type: "response", requestId, payload: result }));
    } catch (err) {
      console.error("mcp handler", method, err);
      sock.send(JSON.stringify({ type: "response", requestId, error: String(err.message ?? err) }));
    }
  });

  sock.addEventListener("close", (ev) => {
    if (sock !== ws) return;
    ws = null;
    emit("disconnected", { code: ev.code, reason: ev.reason });
    scheduleReconnect();
  });

  sock.addEventListener("error", (ev) => {
    if (sock !== ws) return;
    console.warn("mcp ws error", ev);
    emit("error", { error: "connection error (see console)" });
  });
}

function teardownSocket() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    const sock = ws;
    ws = null;
    try { sock.close(); } catch { /* ignore */ }
  }
}

export function disconnect() {
  wantConnected = false;
  teardownSocket();
}

// Called by ui.js whenever the user changes the repo target so the
// hub's ListSessions tool surfaces fresh context.
export function updateTarget(target) {
  currentTarget = target;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "target", target }));
  }
}

async function dispatch(method, payload) {
  switch (method) {
    case "search": {
      const name = (payload.name ?? "").trim();
      const raw = await wasmSearch(name);
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    }
    case "uiSearch": {
      const name = (payload.name ?? "").trim();
      const input = document.getElementById("name");
      const button = document.getElementById("gosubmit");
      if (!input || !button) throw new Error("search UI not mounted");
      input.value = name;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      button.click();
      return { ok: true, driven: name };
    }
    case "ping":
      return { ok: true, at: new Date().toISOString() };
    default:
      throw new Error(`unknown method: ${method}`);
  }
}
