variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "domain_name" {
  description = "Placeholder — set the real domain before first apply."
  type        = string
  default     = "dev.pk-literature.example"
}

variable "create_hosted_zone" {
  type    = bool
  default = true
}

variable "alarm_email" {
  description = "Placeholder — set before first apply."
  type        = string
  default     = "alerts+dev@pk-literature.example"
}

variable "azs" {
  type    = list(string)
  default = ["ap-southeast-1a", "ap-southeast-1b"]
}

variable "directus_image_tag" {
  description = "Tag mirrored into pk-literature/directus by .github/workflows/build-directus-image.yml — matches apps/directus/Dockerfile's pinned base. See apps/directus/README.md's \"Known issue\": 11.17.4 and 10.13.4 both crashed on first boot against real RDS Postgres; 12.1.1 is the next candidate, requiring the eventbridge-put-event extension's host range to be widened too."
  type        = string
  default     = "12.1.1"
}

variable "medusa_image_tag" {
  description = "Tag built into pk-literature/medusa by .github/workflows/build-medusa-image.yml. Historically matched the @medusajs/* version pinned in apps/medusa/package.json, but ECR tags are IMMUTABLE (terraform/bootstrap/ecr.tf) and this image also bakes in our own apps/medusa source (medusa-config.ts, src/subscribers, Dockerfile) — a fix to our own code (e.g. medusa-config.ts TLS driver options) needs a new tag to actually roll out even when the upstream Medusa version has not changed, or build-medusa-image.yml just silently skips the push (tag already exists) and the old image keeps running. The -1 suffix marks our own build revision 1 of Medusa 2.17.2."
  type        = string
  default     = "2.17.2-1"
}
