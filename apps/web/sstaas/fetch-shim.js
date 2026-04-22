// Intercepts the network calls upstream's main.js makes to the
// (no-longer-present) Go server, and routes them to local handlers
// backed by PGlite.
//
// Endpoints intercepted:
//   POST /searchN4L     → local search against PGlite
//   POST /SearchAssets  → local asset search
//   POST /Upload        → upload to user's Drive folder
//
// All other URLs pass through to the real fetch.

import { query as dbQuery, getDB } from "./db.js";

const HANDLERS = {
  "/searchN4L":    handleSearchN4L,
  "/SearchAssets": handleSearchAssets,
  "/Upload":       handleUpload,
};

export function installFetchShim() {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = (typeof input === "string" ? input : input?.url) ?? "";
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const handler = HANDLERS[path];
    if (!handler) return origFetch(input, init);
    try {
      const body = await readBody(init);
      const responseJSON = await handler(body);
      return new Response(JSON.stringify(responseJSON), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      console.error("[sstaas shim]", path, e);
      return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
}

async function readBody(init) {
  if (!init?.body) return {};
  if (init.body instanceof FormData) {
    const obj = {};
    for (const [k, v] of init.body.entries()) obj[k] = v;
    return obj;
  }
  if (typeof init.body === "string") {
    try { return JSON.parse(init.body); } catch { return { raw: init.body }; }
  }
  return {};
}

// ---- /searchN4L (MVP placeholder) ----
//
// Upstream's response shape, abbreviated:
//   { Response: "Orbits"|"PageMap"|... , Content: <JSON-encoded payload string>,
//     Time: <iso>, Intent: {...}, Ambient: {...} }
//
// This stub honours name/text searches against the flat n4l_files
// table only. Anything fancy returns an explanatory error so the UI
// shows something meaningful rather than spinning forever.
async function handleSearchN4L(body) {
  const name = (body.name ?? body.query ?? "").trim();
  if (!name) return packageResponse("Error", JSON.stringify("(empty query)"));

  // Backslash commands (\stats, \toc, \theme, etc.) are upstream
  // server-side dispatches. Honour just the harmless ones; everything
  // else returns a "not yet ported" notice.
  if (name.startsWith("\\")) {
    return packageResponse("Error", JSON.stringify(
      `Backslash command "${name}" not yet implemented in client-side fork.`
    ));
  }

  const like = "%" + name.replace(/%/g, "").replace(/_/g, "\\_") + "%";
  const { rows } = await dbQuery(
    `SELECT s, chap FROM nodes
     WHERE s_lower LIKE lower($1)
     ORDER BY length(s) ASC
     LIMIT 25`,
    [like]
  );
  if (rows.length === 0) {
    // Fall back to listing indexed files so the user sees that
    // re-index actually did something even before parsing is wired.
    const fileRows = await dbQuery(
      `SELECT name, length(text) AS bytes
       FROM n4l_files WHERE name ILIKE $1
       ORDER BY name LIMIT 25`,
      [like]
    );
    return packageResponse("Error", JSON.stringify(
      `No nodes match "${name}". (Parser stub: nodes/arrows/links not yet populated.\n` +
      `Indexed files matching: ${fileRows.rows.map((r) => r[0]).join(", ") || "none"})`
    ));
  }

  // Synthesize a minimal Orbits-shaped payload so upstream's renderer
  // doesn't crash. Real shape will land when parsing is ported.
  const orbits = rows.map(([s, chap]) => ({
    Text: s, Chap: chap ?? "", NPtr: { Class: 0, CPtr: 0 }, XYZ: { X: 0, Y: 0, Z: 0 },
    Orbits: [],
  }));
  return packageResponse("Orbits", JSON.stringify(orbits));
}

async function handleSearchAssets(body) {
  return packageResponse("Error", JSON.stringify(
    "Asset search not yet implemented in client-side fork."
  ));
}

async function handleUpload(body) {
  return packageResponse("Error", JSON.stringify(
    "Direct /Upload not supported. Drop files into your chosen Google Drive folder, " +
    "then press Re-index."
  ));
}

function packageResponse(kind, contentJSONString) {
  return {
    Response: kind,
    Content: contentJSONString,
    Time: new Date().toISOString(),
    Intent: {},
    Ambient: {},
  };
}
