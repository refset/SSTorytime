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
    const { PGlite } = await import(
      "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.4.4/dist/index.js"
    );
    pgliteInstance = new PGlite("idb://sstaas-pglite");
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
// Go WASM async bridge. Returns { columns, rows } where rows is an
// array of arrays (positional, not named) — the simplest shape for a
// language bridge.
export async function query(sql, params = []) {
  const db = getDB();
  const r = await db.query(sql, params);
  const columns = (r.fields ?? []).map((f) => f.name);
  const rows = (r.rows ?? []).map((row) => columns.map((c) => row[c]));
  return { columns, rows };
}
