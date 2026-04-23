// GitHub authentication via personal access token (PAT) paste.
//
// Device flow would be nicer UX but GitHub's /login/* endpoints don't
// send CORS headers, so any browser-only SPA is stuck with either a
// proxy (infra) or PATs (paste ceremony). PATs it is.
//
// Tokens persist in localStorage across reloads; revoking them at
// github.com/settings/tokens invalidates the cached token, which we
// drop on the next 401 from the API.

const USER_URL    = "https://api.github.com/user";
const STORAGE_KEY = "sstaas-github-token";

let currentToken = null; // string | null
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try { fn({ token: currentToken }); }
    catch (e) { console.error("auth listener:", e); }
  }
}

function loadStoredToken() {
  try { return localStorage.getItem(STORAGE_KEY); }
  catch { return null; }
}

function storeToken(t) {
  try {
    if (t) localStorage.setItem(STORAGE_KEY, t);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* private mode, etc. */ }
}

export async function initAuth() {
  currentToken = loadStoredToken();
  notify();
}

// Validate a candidate token against api.github.com/user. On success
// we cache it and broadcast; on failure we leave the old token alone
// and throw so the caller can surface the error.
export async function signInWithToken(rawToken) {
  const token = (rawToken ?? "").trim();
  if (!token) throw new Error("token is empty");
  const r = await fetch(USER_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (r.status === 401) throw new Error("token rejected by GitHub (401)");
  if (!r.ok) throw new Error(`GitHub /user returned ${r.status}`);
  const user = await r.json();
  currentToken = token;
  storeToken(token);
  cachedUser = { token, user };
  notify();
  return user;
}

export function signOut() {
  currentToken = null;
  cachedUser = null;
  storeToken(null);
  notify();
}

export function getToken() { return currentToken; }
export function isSignedIn() { return !!currentToken; }

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Called by api layer when a 401 comes back — the token was revoked
// or rotated.
export function invalidateToken() {
  if (!currentToken) return;
  currentToken = null;
  cachedUser = null;
  storeToken(null);
  notify();
}

let cachedUser = null;
export async function getUser() {
  if (!currentToken) return null;
  if (cachedUser?.token === currentToken) return cachedUser.user;
  const r = await fetch(USER_URL, {
    headers: { Authorization: `Bearer ${currentToken}`, Accept: "application/vnd.github+json" },
  });
  if (r.status === 401) { invalidateToken(); return null; }
  if (!r.ok) throw new Error(`github user ${r.status}`);
  const user = await r.json();
  cachedUser = { token: currentToken, user };
  return user;
}
