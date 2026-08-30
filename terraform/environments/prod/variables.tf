variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "domain_name" {
  description = "Placeholder — set the real domain before first apply."
  type        = string
  default     = "pk-literature.example"
}

# puthagakadai.sg — the Singapore storefront, same backend as
# var.domain_name (shared VPC/RDS/API Gateway; see Task #5's web-sg.tf
# for its own frontend hosting). Only referenced to widen
# api_gateway's CORS allow-list below; the frontend infra that
# actually serves this domain is added separately.
variable "domain_name_sg" {
  description = "Placeholder — set the real puthagakadai.sg domain before first apply."
  type        = string
  default     = "sg.pk-literature.example"
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
  description = "Tag pushed by .github/workflows/build-directus-image.yml (its own directus_image_tag input, separate from the upstream directus_version build-arg). ECR tags are IMMUTABLE (terraform/bootstrap/ecr.tf), and this image bakes in our own layer on top of the pinned upstream directus/directus base (eventbridge-put-event extension, RDS CA bundle for the direct-to-RDS test, promote-staging-book, decrement-inventory-stock, image-url-display, image-url-preview, approve-button, publish-toggle-button) — a change to that layer needs a new tag to roll out even when the upstream version hasn't moved, same as medusa_image_tag's own -N convention. The -11 suffix extends the Books/Works editorial UI to match staging_books: adds the publish-toggle-button interface (catalog.books.status - a genuine two-way Publish/Unpublish toggle, unlike approve-button's one-way ratchet; deliberately does NOT pre-approve the parent Work before publishing, so catalog.sql's enforce_book_work_status trigger can reject the publish outright and surface that rejection to the editor, by product decision), and generalizes approve-button itself with a configurable `finalStatuses` option so works.status can reuse it (a Work's own 'already decided' set includes 'published', not just 'approved', since enforce_book_work_status auto-promotes a Work to 'published' the moment any of its Books publishes - confirmed live -10's approve-button primaryKey/collection assumption was correct, but this new options schema itself is unverified the same way -10's was, alongside the two new bulk Publish/Unpublish manual Flows' operation shape (same item-update uncertainty as -10's bulk-approve Flow). Must be built from whichever branch/ref actually has both apps/directus/extensions/interfaces/publish-toggle-button and the updated approve-button source on it - see -7's own caution below, same mistake class. The -10 suffix adds the approve-button interface extension, replacing staging_books.status's default enum dropdown with a single Approve action (see bootstrap.ts's ensureApproveButtonInterface and extensions/interfaces/approve-button's own header comment) - built alongside the staging_book_status enum rename ('merged' -> 'promoted', migration 20260101000023) and staging_books' field reordering/import_run_id relation wiring, none of which need a new image on their own, but this interface does. Two pieces of this batch are NOT verified against a live Directus instance the way this repo's SQL fixes have been (no way to run the real admin app from this sandbox) - the approve-button interface's assumption that Directus's Form passes `primaryKey`/`collection` as props to a field interface (long-standing documented Directus convention, but unverified here), and the bulk-approve manual Flow's operation type/options shape (`item-update`) - both need a live check right after this deploys. Must be built from whichever branch/ref actually has apps/directus/extensions/interfaces/approve-button on it - see -7's own caution below, same mistake class. The -9 suffix adds the image-url-preview interface extension: image-url-display (a Directus Display) only ever renders inside Table/list cells, never the record's own Detail/Edit page - Displays and Interfaces are separate Directus extension types, confirmed live once cover_s3_key/staging_media.s3_key were rendering correctly in Table view (#112/#114) but still showed as a plain text box on the Edit page. image-url-preview is the Interface-type companion (same value/URL-prefix rendering) wired onto the same fields by bootstrap.ts's ensureImageThumbnailDisplays, now also marked readonly on the two staging-side fields (never media_assets - a promoted catalog record editors may legitimately hand-fix) since both are exclusively system-written. Must be built from whichever branch/ref actually has apps/directus/extensions/interfaces/image-url-preview on it - see -7's own caution below, same mistake class. The -8 suffix fixes image-url-display's own bug found live in -7: it declared `types: ['string']`, but all three fields it's wired onto (staging_books.cover_source_url, staging_media.source_url, catalog.media_assets.s3_key) are Postgres `text` columns, which Directus maps to its own 'text' type, not 'string' - the extension loaded and showed as enabled under Settings -> Extensions, but never appeared as a selectable Display option on any of those fields. Now declares `types: ['string', 'text']`. -7 is permanently wrong (immutable tags) and must never be referenced again, even though - unlike -5/-3 below - it was at least built from the right ref this time. The -7 suffix added the image-url-display extension itself (cover-image thumbnails in Directus's list/detail views, wired onto those same three fields by bootstrap.ts's ensureImageThumbnailDisplays) - must be built from whichever branch/ref actually has apps/directus/extensions/displays/image-url on it; check before dispatching, same caution as every prior bump on this variable given this exact class of mistake has happened repeatedly (see -5/-3 below). The -6 suffix's intended content is identical to what -5 was meant to be (adds the decrement-inventory-stock operation - three order channels / shared inventory pool work: apps/api-commerce's inventory-sync-consumer and apps/medusa's store-order creation route both call into it via a webhook Flow, see bootstrap.ts's ensureInventoryDecrementFlow), but -5 itself got built and pushed from main - the workflow dispatched against the wrong ref again (same mistake class as -3 below), and worse, even the *intended* ref (end2end) would have been wrong too: decrement-inventory-stock only exists on the still-open medusa-commerce-orders-admin branch (PR #99, based on end2end but not merged into it) - immutable ECR tags mean -5 can't be corrected under the same tag, so it's permanently a stale/wrong build and must never be referenced again. The -4 suffix's intended content was identical to what -3 was meant to be (moves both extensions from extensions/operations/<name>/ to extensions/<name>/, flat, no type subdirectory, in the Dockerfile's final COPY destinations - confirmed live that @directus/extensions' resolveFsExtensions() only recognizes extensions directly under EXTENSIONS_PATH), but -3 itself got built and pushed from main (the workflow dispatched against the wrong ref, before this Dockerfile fix had merged) - immutable ECR tags mean that mistake can't be corrected under the same tag, so -3 is permanently a stale/wrong build and must never be referenced again. Revision 2 added promote-staging-book; revision 1 only had the RDS CA bundle."
  type        = string
  default     = "12.1.1-11"
}

variable "medusa_image_tag" {
  description = "Tag built into pk-literature/medusa by .github/workflows/build-medusa-image.yml. Historically matched the @medusajs/* version pinned in apps/medusa/package.json, but ECR tags are IMMUTABLE (terraform/bootstrap/ecr.tf) and this image also bakes in our own apps/medusa source (medusa-config.ts, src/subscribers, Dockerfile, src/admin/**, src/api/admin/**, src/lib/**) — a fix to our own code needs a new tag to actually roll out even when the upstream Medusa version has not changed, or build-medusa-image.yml just silently skips the push (tag already exists) and the old image keeps running. The -3 suffix marks build revision 3 of Medusa 2.17.2: adds the whole commerce-orders admin extension (Store Orders list/detail pages, walk-in-sale creation, three order channels) - must be built from the medusa-commerce-orders-admin branch specifically (PR #99, still open - neither main nor end2end has this source yet), same as directus_image_tag's -6. The -2 suffix marks build revision 2 of Medusa 2.17.2: the Dockerfile's CMD now runs `medusa db:migrate` before `medusa start` - the live first-boot attempt crashed on every Medusa module (Tax, Payment, Fulfillment, Notification, ...) with 'relation medusa.<table> does not exist' because Medusa's own tables were never created (20260401000004_medusa_app_role.sql only creates the medusa schema/role, deliberately leaving Medusa's own module tables to Medusa's own migration CLI)."
  type        = string
  default     = "2.17.2-3"
}

variable "coming_soon_mode" {
  description = "Gates every apps/web route behind a static 'opening soon' page (middleware.ts) until real inventory is populated. Defaults on for a fresh launch — flip to false in terraform.tfvars once ready, no apps/web rebuild needed since this is a plain Lambda runtime env var, not a NEXT_PUBLIC_* build-time one."
  type        = bool
  default     = true
}

# --- puthagakadai.sg (web-sg.tf) — same backend as domain_name above,
# its own frontend hosting only. ---

variable "create_hosted_zone_sg" {
  description = "true to create a new Route53 hosted zone for domain_name_sg, false to look up an existing one."
  type        = bool
  default     = true
}

variable "coming_soon_mode_sg" {
  description = "Same purpose as coming_soon_mode, independent toggle since puthagakadai.sg launches on its own timeline."
  type        = bool
  default     = true
}
