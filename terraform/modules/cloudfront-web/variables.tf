variable "environment" {
  type = string
}

# Defaults to "web" — same reasoning as modules/opennext's own
# service_name variable (added alongside it): keeps every existing
# prod/qa/dev instantiation byte-identical (same OAC names, same cache
# policy name — both unique-per-account resources), and lets a second
# storefront (puthagakadai.sg) instantiate this module again as
# service_name = "web-sg" without colliding on those names.
variable "service_name" {
  type    = string
  default = "web"
}

variable "domain_name" {
  type = string
}

variable "cloudfront_certificate_arn" {
  description = "Must be an ACM cert in us-east-1 — see modules/route53-acm. Same cert as modules/cloudfront (it covers domain_name itself, not just *.domain_name)."
  type        = string
}

variable "hosted_zone_id" {
  type = string
}

variable "static_assets_bucket_id" {
  type = string
}

variable "static_assets_bucket_arn" {
  type = string
}

variable "static_assets_bucket_regional_domain_name" {
  type = string
}

variable "server_function_url_domain" {
  type = string
}

variable "server_function_arn" {
  type = string
}

variable "image_function_url_domain" {
  type = string
}

variable "image_function_arn" {
  type = string
}
