variable "environment" {
  type = string
}

variable "domain_name" {
  type = string
}

variable "regional_certificate_arn" {
  type = string
}

variable "hosted_zone_id" {
  type = string
}

# puthagakadai.sg's frontend calls this SAME shared API Gateway (one
# backend, two storefronts — see Task #5's terraform/environments/prod
# web infra for the SG-specific piece) rather than getting its own API
# domain, so the one CORS-origin list here is the only place that
# needs to know about it. Empty by default — every existing
# environment (qa, dev, and prod before this variable existed) keeps
# exactly its original single-origin behavior.
variable "extra_cors_origins" {
  type    = list(string)
  default = []
}
