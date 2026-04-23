// Public configuration. For local dev, copy config.local.example.js
// to config.local.js to override any of these.

export const CONFIG = {
  // Filenames treated as N4L source.
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
