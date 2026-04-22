// Public configuration. The OAuth client ID is intentionally public —
// it identifies the app to Google but is not a secret. The Pages
// workflow rewrites this from a repository variable at deploy time.
// For local dev, copy config.local.example.js to config.local.js.

export const CONFIG = {
  googleClientId: "REPLACE_WITH_OAUTH_CLIENT_ID.apps.googleusercontent.com",

  // Per-file scope. The app only sees files the user explicitly opens
  // or creates through it.
  driveScope: "https://www.googleapis.com/auth/drive.file",

  // App-private meta file inside the chosen Drive folder.
  metaFileName: ".sstaas-index.json",

  // Filenames the re-indexer treats as N4L source.
  n4lExtensions: [".n4l"],

  // Versions surfaced in the footer; bump when legal/*.html changes.
  termsVersion: "2026-04-22",
  privacyVersion: "2026-04-22",
};

try {
  const local = await import("./config.local.js");
  Object.assign(CONFIG, local.CONFIG ?? {});
} catch {
  /* no local override; fine */
}
