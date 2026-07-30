variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "domain_name" {
  description = "Placeholder — set the real domain before first apply."
  type        = string
  default     = "pk-literature.example"
}

variable "create_hosted_zone" {
  type    = bool
  default = true
}

variable "alarm_email" {
  description = "Placeholder — set before first apply. Should be a monitored team address/distribution list, not an individual, for prod."
  type        = string
  default     = "alerts@pk-literature.example"
}

variable "azs" {
  type    = list(string)
  default = ["ap-southeast-1a", "ap-southeast-1b"]
}

# --- Existing VPC to reuse (modules/vpc's create_vpc = false mode) ---
#
# This account already has a VPC set up for other purposes — main.tf's
# module "vpc" reuses it instead of provisioning a second one. Every
# value below is a placeholder; REPLACE before first apply. Pull the
# real values from the AWS account, e.g.:
#   aws ec2 describe-vpcs --query 'Vpcs[].[VpcId,CidrBlock,Tags]'
#   aws ec2 describe-subnets --filters Name=vpc-id,Values=<vpc-id> \
#     --query 'Subnets[].[SubnetId,AvailabilityZone,CidrBlock,MapPublicIpOnLaunch,Tags]'
#   aws ec2 describe-route-tables --filters Name=vpc-id,Values=<vpc-id>
#   aws ec2 describe-nat-gateways --filter Name=vpc-id,Values=<vpc-id>
#
# You're responsible for confirming which of the existing subnets
# actually match each tier's routing guarantee
# (infrastructure/networking.md) — this module has no way to verify
# that a subnet you list here as "private isolated" truly has no
# NAT/IGW route, the way a freshly-created one is guaranteed to.
variable "existing_vpc_id" {
  description = "REPLACE before first apply."
  type        = string
  default     = "vpc-REPLACE_ME"
}

variable "existing_public_subnet_ids" {
  description = "REPLACE before first apply. Subnets with a route to an Internet Gateway."
  type        = list(string)
  default     = ["subnet-REPLACE_ME_PUBLIC_1", "subnet-REPLACE_ME_PUBLIC_2"]
}

variable "existing_private_isolated_subnet_ids" {
  description = "REPLACE before first apply. Subnets with NO route to NAT/IGW at all — RDS, RDS Proxy, and the read-heavy Lambdas + Directus ECS."
  type        = list(string)
  default     = ["subnet-REPLACE_ME_ISOLATED_1", "subnet-REPLACE_ME_ISOLATED_2"]
}

variable "existing_private_nat_subnet_ids" {
  description = "REPLACE before first apply. Subnets that route 0.0.0.0/0 through a NAT Gateway — Commerce Lambda, Medusa ECS."
  type        = list(string)
  default     = ["subnet-REPLACE_ME_NAT_1", "subnet-REPLACE_ME_NAT_2"]
}

variable "existing_private_isolated_route_table_id" {
  description = "REPLACE before first apply. Route table attached to the private-isolated subnets — modules/vpc-endpoints associates the S3 gateway endpoint with it."
  type        = string
  default     = "rtb-REPLACE_ME"
}

variable "existing_nat_gateway_ids" {
  description = "Optional — feeds modules/cloudwatch's NAT Gateway alarms. Leave empty if you don't want those alarms wired to the reused infrastructure."
  type        = list(string)
  default     = []
}

variable "existing_interface_endpoint_sg_ids" {
  description = "REPLACE before first apply. Security groups already attached to this reused VPC's existing secretsmanager/events/logs/ecr.api/ecr.dkr interface endpoints (modules/vpc-endpoints' create_endpoints = false path, main.tf). Find via: aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values=<vpc-id> --query 'VpcEndpoints[].Groups[].GroupId'"
  type        = list(string)
  default     = ["sg-REPLACE_ME_1", "sg-REPLACE_ME_2"]
}

variable "directus_image_tag" {
  description = "Tag pushed by .github/workflows/build-directus-image.yml (its own directus_image_tag input, separate from the upstream directus_version build-arg). ECR tags are IMMUTABLE (terraform/bootstrap/ecr.tf), and this image bakes in our own layer on top of the pinned upstream directus/directus base (eventbridge-put-event extension, RDS CA bundle for the direct-to-RDS test, promote-staging-book) — a change to that layer needs a new tag to roll out even when the upstream version hasn't moved, same as medusa_image_tag's own -N convention. The -3 suffix marks build revision 3 of upstream 12.1.1: moves both extensions from extensions/operations/<name>/ to extensions/<name>/ (flat, no type subdirectory) in the Dockerfile's final COPY destinations - confirmed live that @directus/extensions' resolveFsExtensions() only recognizes extensions directly under EXTENSIONS_PATH, so the old operations/-nested layout meant Directus discovered zero extensions the entire time, regardless of EXTENSIONS_PATH (revision 2) being set correctly. Revision 2 added promote-staging-book; revision 1 only had the RDS CA bundle."
  type        = string
  default     = "12.1.1-3"
}

variable "medusa_image_tag" {
  description = "Tag built into pk-literature/medusa by .github/workflows/build-medusa-image.yml. Historically matched the @medusajs/* version pinned in apps/medusa/package.json, but ECR tags are IMMUTABLE (terraform/bootstrap/ecr.tf) and this image also bakes in our own apps/medusa source (medusa-config.ts, src/subscribers, Dockerfile) — a fix to our own code (e.g. medusa-config.ts TLS driver options, or the Dockerfile's own CMD) needs a new tag to actually roll out even when the upstream Medusa version has not changed, or build-medusa-image.yml just silently skips the push (tag already exists) and the old image keeps running. The -2 suffix marks build revision 2 of Medusa 2.17.2: the Dockerfile's CMD now runs `medusa db:migrate` before `medusa start` - the live first-boot attempt crashed on every Medusa module (Tax, Payment, Fulfillment, Notification, ...) with 'relation medusa.<table> does not exist' because Medusa's own tables were never created (20260401000004_medusa_app_role.sql only creates the medusa schema/role, deliberately leaving Medusa's own module tables to Medusa's own migration CLI)."
  type        = string
  default     = "2.17.2-2"
}

variable "coming_soon_mode" {
  description = "Gates every apps/web route behind a static 'opening soon' page (middleware.ts) until real inventory is populated. Defaults on for a fresh launch — flip to false in terraform.tfvars once ready, no apps/web rebuild needed since this is a plain Lambda runtime env var, not a NEXT_PUBLIC_* build-time one."
  type        = bool
  default     = true
}
