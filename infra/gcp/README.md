# GCP setup for SSToryGraph (client-side-drive)

This directory holds the bits of GCP setup we can express in Terraform,
plus a checklist for the steps Google still requires you to click
through in the Cloud Console.

("CloudFormation or whatever" maps to **Terraform** for GCP. Deployment
Manager is deprecated; Terraform via the Google provider is the
official declarative path.)

## What this app actually needs

This app is 100% client-side. There is **no** Cloud Run, Cloud SQL,
GKE, Pub/Sub, or App Engine. The GCP project exists only so Google
will let the browser-side code:

1. Sign users in (OAuth via Google Identity Services).
2. Read/write files in a folder of the user's Drive (`drive.file` scope).

So the GCP project just needs:

- The **Drive API** enabled.
- An **OAuth consent screen** configured (External, or Internal for
  Google Workspace orgs).
- A **Web Application OAuth Client ID** with the deploy origin
  (e.g. `https://refset.github.io`) under "Authorized JavaScript
  origins". Redirect URIs can stay empty — GIS uses the implicit token
  flow with origin-only checks.
- (Optional) A **Browser API Key** once we wire up the Drive Picker.

## What Terraform handles vs. what you click

| Step                                  | Terraform | Manual |
| ------------------------------------- | --------- | ------ |
| Create / select project               | yes       | —      |
| Enable Drive API                      | yes       | —      |
| OAuth consent screen (External)       | partial†  | yes    |
| Web OAuth Client ID                   | partial‡  | recommended |
| Browser API Key (Picker, future)      | yes       | —      |

† `google_iap_brand` only supports **internal** consent screens for
Workspace orgs, and only one brand per project. For an **external**
consent screen you must use the Cloud Console UI.

‡ `google_iap_client` is tied to IAP brands, which is the wrong product
for this use case (we're calling the Drive API from a browser, not
gating Cloud Run with IAP). Create the Web OAuth Client ID by hand
once, then paste the client ID into the SPA config or set it as a
GitHub Pages workflow variable.

## One-time manual setup

1. Pick or create a GCP project. Note its project ID.
2. Configure the **OAuth consent screen**:
   Cloud Console → APIs & Services → OAuth consent screen
   - User type: External.
   - App name: `SSToryGraph` (or your own brand).
   - User support email + developer contact: yours.
   - Authorized domains: your deploy domain (e.g. `github.io`).
   - Scopes: add `.../auth/drive.file`. Nothing sensitive beyond that.
   - Test users: add the Google accounts that may sign in while in test mode.
   - `drive.file` is non-sensitive so no Google verification is needed
     to promote to **In production**.
3. Create the **Web Application OAuth Client ID**:
   APIs & Services → Credentials → Create credentials → OAuth client ID
   - Application type: Web application.
   - Authorized JavaScript origins: every origin you serve from.
     For example:
       - `https://refset.github.io`   (production)
       - `http://localhost:18090`     (local dev)
   - Authorized redirect URIs: leave empty.
   - Save and copy the client ID.
4. Set the client ID in the SPA config:
   - Local dev: copy `apps/web/sstaas/config.local.example.js` to
     `config.local.js` and set `googleClientId`.
   - Deployed: see `.github/workflows/pages.yml` — the workflow
     rewrites `config.js` from a repo **variable**
     (`GOOGLE_OAUTH_CLIENT_ID`).

## Apply the Terraform

```sh
cd infra/gcp
terraform init
terraform apply -var="project_id=your-gcp-project-id"
```

Idempotent. If the project doesn't exist Terraform creates it under
your billing account; if it does exist Terraform just enables the
Drive API on it.

## Future work

When we wire up the Drive **Picker** (richer folder selection than
pasting a folder ID), add a Browser API Key restricted by HTTP
referrer to the deploy origin. The Terraform here produces it via
`google_apikeys_key` (currently commented out). The SPA config would
grow a `googleApiKey` field.
