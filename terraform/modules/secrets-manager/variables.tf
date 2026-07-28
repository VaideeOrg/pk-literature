variable "environment" {
  type = string
}

variable "rds_master_username" {
  type    = string
  default = "pk_literature_admin"
}

variable "directus_db_username" {
  description = "Matches the DB role created by migration 20260101000006_directus_app_role.sql."
  type        = string
  default     = "directus_app"
}

variable "directus_admin_email" {
  # Directus's admin-account email validator (Joi's string().email(),
  # which checks the domain's TLD against the real IANA list by
  # default) rejects the placeholder "admin@pk-literature.example" -
  # ".example" is an RFC 2606 reserved domain, never delegated as a
  # real TLD. A real, checked-in-by-request address is used instead of
  # another placeholder since this becomes the login for Directus's
  # first super-admin account.
  type    = string
  default = "www.vaidees@gmail.com"
}

variable "medusa_db_username" {
  description = "Matches the DB role created by migration 20260401000004_medusa_app_role.sql."
  type        = string
  default     = "medusa_app"
}

variable "medusa_admin_email" {
  type    = string
  default = "admin@pk-literature.example"
}
