// Re-index orchestrator for the GitHub flow. Lists the selected repo +
// branch, filters to .n4l files (plus any SSTconfig/*.sst arrow-config
// files), fetches each, hands the batch to the WASM parser.

import * as gh from "./github.js";
import { parseN4L } from "./bridge.js";
import { CONFIG } from "./config.js";

// Known-broken example files in markburgess/SSTorytime@main (upstream
// content bugs, not integration bugs — reported separately). Skipping
// these keeps the demo tidy until upstream fixes them.
const SKIPLIST = new Set([
  "examples/AgenticAIvsPromiseTheory/notes_from_CarlosEPerez.n4l",
  "examples/ConstructionProcesses.n4l",
  "examples/Darwin.n4l",
  "examples/FriendsAndFiends.n4l",
  "examples/MobyDickNotes.n4l",
  "examples/MurderMostHorrid/cluedo.n4l",
  "examples/PromiseTheory.n4l",
  "examples/brains.n4l",
  "examples/branches.n4l",
  "examples/chinese.n4l",
  "examples/chinese_comments.n4l",
  "examples/chinese_story.n4l",
  "examples/dataconsistency.n4l",
  "examples/doors.n4l",
  "examples/doubleslit.n4l",
  "examples/inferences.n4l",
  "examples/knowledge.n4l",
  "examples/MusicCollection/example_collection.n4l",
  "examples/openshift.n4l",
  "examples/ownership.n4l",
  "examples/reasoning.n4l",
  "examples/research.n4l",
  "examples/smartspace_iot.n4l",
  "examples/unicode.n4l",
  "examples/wardleymap.n4l",
]);

function classify(entries, n4lExts, n4lPrefix) {
  const exts = n4lExts.map((e) => e.toLowerCase());
  const n4l = [], configs = [];
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const lower = e.path.toLowerCase();
    // Configs come from any SSTconfig/ anywhere in the repo — a root
    // SSTconfig/ applies globally; per-dataset ones sit next to their
    // data. We don't path-filter configs, so pointing at a subdir
    // still picks up the root-level arrow declarations.
    if (lower.endsWith(".sst") && /(^|\/)sstconfig\//.test(lower)) {
      configs.push(e);
      continue;
    }
    // N4L files respect the prefix filter, and we skip known-broken
    // upstream examples so the default demo stays tidy.
    if (n4lPrefix && !e.path.startsWith(n4lPrefix)) continue;
    if (SKIPLIST.has(e.path)) continue;
    if (exts.some((x) => lower.endsWith(x))) n4l.push(e);
  }
  return { n4l, configs };
}

// target: { owner, repo, branch?, path? }
// Returns: { files, configs, out, fileCount }
export async function reindex(target, { onProgress = () => {} } = {}) {
  const { owner, repo, branch, path } = target;
  onProgress({ stage: "list", message: `Listing ${owner}/${repo}${branch ? `@${branch}` : ""}…` });
  const { branch: resolvedBranch, entries } = await gh.listTree(owner, repo, branch ?? "HEAD");
  const prefix = path && path !== "/" ? path.replace(/^\/|\/$/g, "") + "/" : "";
  const { n4l, configs } = classify(entries, CONFIG.n4lExtensions, prefix);
  if (n4l.length === 0) {
    onProgress({ stage: "done", message: `No .n4l files found under ${path || "/"}.` });
    return { files: {}, configs: {}, out: null, fileCount: 0, branch: resolvedBranch };
  }

  const cfgSuffix = configs.length ? ` (plus ${configs.length} SSTconfig file(s))` : "";
  onProgress({ stage: "fetch", message: `Fetching ${n4l.length} .n4l file(s)${cfgSuffix}…` });
  const files = {};
  for (let i = 0; i < n4l.length; i++) {
    const e = n4l[i];
    onProgress({ stage: "fetch", message: `Fetching ${i + 1}/${n4l.length}: ${e.path}` });
    files[e.path] = await gh.getFileText(owner, repo, e.path, resolvedBranch);
  }
  const cfgPayload = {};
  for (let i = 0; i < configs.length; i++) {
    const e = configs[i];
    onProgress({ stage: "fetch", message: `Fetching config ${i + 1}/${configs.length}: ${e.path}` });
    cfgPayload[e.path] = await gh.getFileText(owner, repo, e.path, resolvedBranch);
  }

  onProgress({ stage: "parse", message: `Parsing ${n4l.length} file(s) — this takes a few seconds per file…` });
  const out = await parseN4L(files, configs.length ? cfgPayload : undefined, {
    onProgress: (msg) => onProgress({ stage: "parse", message: msg }),
  });
  return { files, configs: cfgPayload, out, fileCount: n4l.length, branch: resolvedBranch };
}
