// Google OAuth via the Google Identity Services token client.
// Tokens live in memory only — refreshing the page signs the user out.

import { CONFIG } from "./config.js";

let tokenClient = null;
let currentToken = null; // { access_token, expires_at }
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try { fn({ token: currentToken }); }
    catch (e) { console.error("auth listener:", e); }
  }
}

function waitForGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    let tries = 0;
    const t = setInterval(() => {
      if (window.google?.accounts?.oauth2) { clearInterval(t); resolve(); }
      else if (++tries > 200) { clearInterval(t); reject(new Error("Google Identity Services failed to load")); }
    }, 50);
  });
}

export async function initAuth() {
  await waitForGis();
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.googleClientId,
    scope: CONFIG.driveScope,
    callback: (resp) => {
      if (resp.error) { console.error("oauth error", resp); return; }
      currentToken = {
        access_token: resp.access_token,
        expires_at: Date.now() + (resp.expires_in ?? 3600) * 1000,
      };
      notify();
    },
  });
}

export function signIn() {
  if (!tokenClient) throw new Error("auth not initialized");
  tokenClient.requestAccessToken({ prompt: "" });
}

export function signOut() {
  if (currentToken?.access_token) {
    window.google?.accounts?.oauth2?.revoke?.(currentToken.access_token, () => {});
  }
  currentToken = null;
  notify();
}

export function getToken() {
  if (!currentToken) return null;
  if (Date.now() >= currentToken.expires_at - 30_000) return null;
  return currentToken.access_token;
}

export function isSignedIn() { return getToken() !== null; }

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
