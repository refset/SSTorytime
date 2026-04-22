// PGlite initialization + minimal flat schema.
//
// We deliberately avoid Postgres composite types (NodePtr, Link[],
// etc.) in this MVP. The upstream schema uses CREATE TYPE + composite
// columns; faithfully reproducing those in PGlite requires either a
// full pq-style row decoder in our JS bridge or extensive Scan()
// rewriting in the Go package. Both are big jobs. For now we use a
// flat schema that lets us round-trip parsed N4L into the DB and run
// LIKE/text searches; the richer cone/path queries are a TODO.

import { CONFIG } from "./config.js";

let pgliteInstance = null;
let pgliteReady = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sstaas_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Each parsed N4L file lives as a row so we can show what's been
-- ingested and re-parse just the changed ones.
CREATE TABLE IF NOT EXISTS n4l_files (
  drive_file_id   TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  text            TEXT NOT NULL,
  sha256          TEXT,
  modified_time   TEXT,
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Flat node/arrow/link tables. Real upstream parsing will populate
-- these via the WASM parseN4L diff once it's ported.
CREATE TABLE IF NOT EXISTS nodes (
  id              BIGSERIAL PRIMARY KEY,
  drive_file_id   TEXT REFERENCES n4l_files(drive_file_id) ON DELETE CASCADE,
  s               TEXT NOT NULL,
  chap            TEXT,
  s_lower         TEXT GENERATED ALWAYS AS (lower(s)) STORED
);
CREATE INDEX IF NOT EXISTS nodes_s_lower_idx ON nodes (s_lower);
CREATE INDEX IF NOT EXISTS nodes_chap_idx    ON nodes (chap);

CREATE TABLE IF NOT EXISTS arrows (
  id              BIGSERIAL PRIMARY KEY,
  drive_file_id   TEXT REFERENCES n4l_files(drive_file_id) ON DELETE CASCADE,
  short           TEXT NOT NULL,
  long            TEXT,
  st_type         INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS arrows_short_idx ON arrows (short);

CREATE TABLE IF NOT EXISTS links (
  id              BIGSERIAL PRIMARY KEY,
  drive_file_id   TEXT REFERENCES n4l_files(drive_file_id) ON DELETE CASCADE,
  src_node_id     BIGINT REFERENCES nodes(id) ON DELETE CASCADE,
  dst_node_id     BIGINT REFERENCES nodes(id) ON DELETE CASCADE,
  arrow_id        BIGINT REFERENCES arrows(id) ON DELETE CASCADE,
  weight          REAL,
  context         TEXT
);
CREATE INDEX IF NOT EXISTS links_src_idx ON links (src_node_id);
CREATE INDEX IF NOT EXISTS links_dst_idx ON links (dst_node_id);
`;

export async function initDB() {
  if (pgliteReady) return pgliteReady;
  pgliteReady = (async () => {
    // PGlite 0.4.4's idb:// persistence mode never resolves waitReady
    // in our environment (verified via isolated spikes — a fresh
    // `new PGlite('idb://anything')` hangs forever, while
    // `new PGlite()` in-memory comes up in ~7s). Tracked in
    // ROADMAP_CLIENT_SIDE.md as a known issue to revisit once a
    // future PGlite release fixes it or once we wire OPFS persistence
    // (which needs cross-origin isolation headers we don't have on
    // GitHub Pages anyway). For now we run in-memory: the parsed
    // graph is rebuildable on demand via Re-index, since Google Drive
    // holds the source of truth.
    const { PGlite } = await import(
      "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.4.4/dist/index.js"
    );
    pgliteInstance = new PGlite();
    await pgliteInstance.waitReady;
    await pgliteInstance.exec(SCHEMA_SQL);
    return pgliteInstance;
  })();
  return pgliteReady;
}

export function getDB() {
  if (!pgliteInstance) throw new Error("PGlite not initialized — call initDB() first");
  return pgliteInstance;
}

// Promise-returning query helper used both by JS handlers and by the
// Go WASM async bridge. Returns { columns, types, rows, affectedRows }
// where rows is an array of arrays (positional, not named) — the
// simplest shape to send through a language bridge.
//
// `types` is the array of Postgres OIDs from PGlite's field metadata
// — the Go-side pglite-js driver uses these to map values to the
// right driver.Value type (int64 vs float64 etc.).
//
// PGlite has two entry points with different capabilities:
//   - db.query(sql, params): single statement, supports parameters
//     (goes through a prepared-statement path, which hard-errors on
//     multi-statement input with "cannot insert multiple commands
//     into a prepared statement")
//   - db.exec(sql): multiple semicolon-separated statements, no params
// Upstream's GraphToDB emits BEGIN;...COMMIT; batches, so we sniff
// multi-statement input and route those through exec().
export async function query(sql, params = []) {
  const db = getDB();

  if (looksMultiStatement(sql)) {
    if (params && params.length) {
      throw new Error("pglite-js: multi-statement SQL with parameters is not supported");
    }
    const results = await db.exec(sql);
    let affected = 0;
    for (const r of results ?? []) affected += r.affectedRows ?? 0;
    return { columns: [], types: [], rows: [], affectedRows: affected };
  }

  const r = await db.query(sql, params);
  const fields = r.fields ?? [];
  const columns = fields.map((f) => f.name);
  const types = fields.map((f) => f.dataTypeID ?? 0);
  const rows = (r.rows ?? []).map((row) => columns.map((c) => row[c]));
  return { columns, types, rows, affectedRows: r.affectedRows ?? 0 };
}

// Returns true if sql has a `;` that isn't at the final trimmed
// position, respecting single-quoted strings (SQL uses '' to escape an
// embedded single quote). Conservative by design: if in doubt, we'd
// rather take the exec() path than fail on a batch.
function looksMultiStatement(sql) {
  const trimmed = sql.trim();
  const last = trimmed.length - 1;
  let inStr = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "'") {
      if (inStr && trimmed[i + 1] === "'") { i++; continue; }
      inStr = !inStr;
      continue;
    }
    if (c === ";" && !inStr && i < last) return true;
  }
  return false;
}
