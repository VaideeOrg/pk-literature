variable "environment" {
  type = string
}

variable "artifact_bucket" {
  description = "S3 bucket forwarded to both lambda-service module calls below — see that module's matching variable and environments/<env>/main.tf's module.lambda_artifacts."
  type        = string
}

variable "server_zip_path" {
  description = "Path to @opennextjs/aws's server-function deployment package, built by apps/web/scripts/package-opennext.sh."
  type        = string
}

variable "server_zip_hash" {
  type = string
}

variable "server_environment_variables" {
  type    = map(string)
  default = {}
}

variable "server_memory_size" {
  type    = number
  default = 1024
}

variable "server_timeout" {
  # SSR of a page that itself calls out to apps/api-catalog/-feed/-search
  # /-commerce/-identity over HTTPS — generous relative to those
  # services' own 10-30s timeouts since a slow page can chain several.
  type    = number
  default = 30
}

variable "image_zip_path" {
  description = "Path to @opennextjs/aws's image-optimization-function deployment package, built by the same package-opennext.sh."
  type        = string
}

variable "image_zip_hash" {
  type = string
}

variable "image_memory_size" {
  # next/image's sharp-based resizing is memory-hungry; @opennextjs/aws's
  # own docs recommend >=1536MB for the image function specifically.
  type    = number
  default = 1536
}

variable "image_timeout" {
  type    = number
  default = 25
}
