# GCP setup for the client-side SSToryGraph SPA. Only what's reliably
# automatable lives here; the OAuth consent screen + Web Client ID
# still need clicks in the Cloud Console (see README.md).

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.40"
    }
  }
}

variable "project_id" {
  description = "Existing GCP project ID for the SSToryGraph SPA."
  type        = string
}

variable "region" {
  description = "Default region (only used by future resources; the SPA itself is regionless)."
  type        = string
  default     = "europe-west1"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "drive" {
  service                    = "drive.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false
}

# Optional: Browser API Key for the future Drive Picker integration.
# Uncomment when wiring up the Picker; restrict it to HTTP referrers
# from your deploy origin.
#
# resource "google_apikeys_key" "browser" {
#   name         = "sstorytime-browser-key"
#   display_name = "SSToryGraph browser key"
#   restrictions {
#     api_targets {
#       service = "drive.googleapis.com"
#     }
#     api_targets {
#       service = "picker.googleapis.com"
#     }
#     browser_key_restrictions {
#       allowed_referrers = [
#         "https://refset.github.io/*",
#         "http://localhost:18090/*",
#       ]
#     }
#   }
# }

output "project_id" {
  value = var.project_id
}

output "next_steps" {
  value = <<EOT
Drive API enabled on project ${var.project_id}.

Now do the manual steps in infra/gcp/README.md:
  1. Configure the OAuth consent screen (External, drive.file scope).
  2. Create a Web Application OAuth Client ID with the deploy origin
     in Authorized JavaScript origins.
  3. Set the client ID in apps/web/sstaas/config.local.js for local dev,
     or as the GOOGLE_OAUTH_CLIENT_ID GitHub Pages workflow variable.
EOT
}
