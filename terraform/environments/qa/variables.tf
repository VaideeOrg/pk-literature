variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "domain_name" {
  description = "Placeholder — set the real domain before first apply."
  type        = string
  default     = "qa.pk-literature.example"
}

variable "create_hosted_zone" {
  type    = bool
  default = true
}

variable "alarm_email" {
  description = "Placeholder — set before first apply."
  type        = string
  default     = "alerts+qa@pk-literature.example"
}

variable "azs" {
  type    = list(string)
  default = ["ap-southeast-1a", "ap-southeast-1b"]
}

variable "directus_image_tag" {
  description = "Tag mirrored into pk-literature/directus by .github/workflows/build-directus-image.yml — matches apps/directus/Dockerfile's pinned base. See apps/directus/README.md's \"Known issue\": 11.17.4 crashed on first boot against real RDS Postgres; 10.13.4 is the next untested candidate."
  type        = string
  default     = "10.13.4"
}

variable "medusa_image_tag" {
  description = "Tag built into pk-literature/medusa by .github/workflows/build-medusa-image.yml — matches the @medusajs/* version pinned in apps/medusa/package.json."
  type        = string
  default     = "2.17.2"
}
