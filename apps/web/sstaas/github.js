// GitHub Contents + Git Data API helpers. CORS-friendly; no backend.

import { getToken, invalidateToken } from "./auth.js";

const API = "https://api.github.com";

function authHeaders(accept = "application/vnd.github+json") {
  const t = getToken();
  const h = { Accept: accept };
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function ghFetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers ?? {}), ...authHeaders() } });
  if (r.status === 401) { invalidateToken(); throw new Error("github auth expired — sign in again"); }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`github ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

export async function getRepo(owner, name) {
  return ghFetch(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
}

// Recursive tree listing, rooted at the branch's tip. Limited to
// 100 000 entries + 7 MB by GitHub; for typical N4L repos that's fine.
// Returns [{path, type, sha, size}].
export async function listTree(owner, name, ref = "HEAD") {
  const repo = await getRepo(owner, name);
  const branch = ref === "HEAD" ? repo.default_branch : ref;
  const branchInfo = await ghFetch(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/${encodeURIComponent(branch)}`,
  );
  const sha = branchInfo.commit?.sha;
  if (!sha) throw new Error(`branch ${branch} has no HEAD`);
  const tree = await ghFetch(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${sha}?recursive=1`,
  );
  if (tree.truncated) {
    console.warn("[sstaas github] tree truncated — large repo, may miss files");
  }
  return { branch, sha, entries: tree.tree ?? [] };
}

// Fetch raw file text via the Contents API. Uses the "raw" accept
// type so we skip the base64 round-trip. Max ~1 MB per call — good
// enough for N4L files.
export async function getFileText(owner, name, path, ref) {
  const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const r = await fetch(url, { headers: { ...authHeaders("application/vnd.github.raw") } });
  if (r.status === 401) { invalidateToken(); throw new Error("github auth expired — sign in again"); }
  if (!r.ok) throw new Error(`github ${r.status} on ${path}`);
  return r.text();
}

