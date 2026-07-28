# Phase 6's Medusa admin surface (SPEC-06 — "Medusa used for order
# operations only", "No catalog ownership"). Own file per
# development/branching.md ("each phase owns its own infra"). See
# apps/medusa/README.md's "Scope boundary" section before assuming this
# manages the same orders apps/api-commerce writes — it runs Medusa's
# own default data model in the `medusa` schema, not `commerce.*`, in
# this pass.
#
# Unlike directus.tf, this ECS task sits in the private-nat tier with
# ecs_medusa_sg (internet egress, ADR-009's "{commerce, Medusa}") — it
# needs to reach Razorpay for refunds. Everything else mirrors
# directus.tf: stored-password DB auth (Medusa's Postgres client has no
# dynamic IAM token refresh either — apps/medusa/medusa-config.ts's own
# comment), one shared admin ALB, one ECS task.

locals {
  medusa_ecr_repository_url = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com/pk-literature/medusa"
  medusa_db_user            = module.secrets_manager.medusa_db_username
}

data "aws_iam_policy_document" "medusa_task" {
  statement {
    effect  = "Allow"
    actions = ["rds-db:connect"]
    resources = [
      "arn:aws:rds-db:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:dbuser:${module.rds_proxy.iam_auth_resource_id}/${local.medusa_db_user}",
    ]
  }

  # apps/medusa/src/subscribers/eventbridge-order-placed.ts calls
  # PutEvents directly under this task role, same direct-grant pattern
  # as ecs-directus's eventbridge-put-event extension.
  statement {
    effect    = "Allow"
    actions   = ["events:PutEvents"]
    resources = [module.eventbridge.bus_arn]
  }
}

module "alb_medusa" {
  source = "../../modules/alb"

  environment              = "prod"
  service_name             = "medusa"
  vpc_id                   = module.vpc.vpc_id
  public_subnet_ids        = module.vpc.public_subnet_ids
  alb_security_group_id    = module.security_groups.alb_admin_sg_id
  domain_name              = var.domain_name
  regional_certificate_arn = module.route53_acm.regional_certificate_arn
  hosted_zone_id           = module.route53_acm.zone_id
  target_port              = 9000
  health_check_path        = "/health"
}

module "ecs_medusa" {
  source = "../../modules/ecs-service"

  environment    = "prod"
  service_name   = "medusa"
  cluster_id     = aws_ecs_cluster.this.id
  image          = "${local.medusa_ecr_repository_url}:${var.medusa_image_tag}"
  container_port = 9000

  # private-nat tier, not private-isolated — see file header.
  subnet_ids         = module.vpc.private_nat_subnet_ids
  security_group_ids = [module.security_groups.ecs_medusa_sg_id]
  target_group_arn   = module.alb_medusa.target_group_arn

  # Same reasoning as ecs_directus's own grace period: the Dockerfile's
  # CMD runs `medusa db:migrate` (migrations + link-sync) before `medusa
  # start` on every boot - real work, not instant. Set proactively here
  # even though Medusa's own crash-and-recover happened to self-heal via
  # ECS's normal restart behavior rather than a health-check-timing
  # loop; a grace period avoids ECS ever fighting a legitimately slow
  # (not crashed) boot the way ecs_directus hit live.
  health_check_grace_period_seconds = 180

  environment_variables = {
    # medusa-config.ts assembles DATABASE_URL from PGHOST/PGPORT/PGUSER/
    # PGDATABASE + the PGPASSWORD secret below — see its own comment
    # for why (ECS `secrets` injects one plain value per env var, never
    # a pre-assembled connection string).
    PGHOST     = module.rds_proxy.proxy_endpoint
    PGPORT     = "5432"
    PGUSER     = local.medusa_db_user
    PGDATABASE = "pk_literature"

    STORE_CORS = "https://${var.domain_name}"
    ADMIN_CORS = "https://medusa.${var.domain_name}"
    AUTH_CORS  = "https://medusa.${var.domain_name}"

    AWS_REGION           = data.aws_region.current.name
    EVENTBRIDGE_BUS_NAME = module.eventbridge.bus_name
  }

  secrets = {
    # :password:: extracts just that JSON key — see
    # secrets-manager module's medusa_db comment for why (RDS
    # Proxy's SECRETS auth needs the secret's username field to
    # match this role; PGPASSWORD still gets just the bare value).
    PGPASSWORD    = "${module.secrets_manager.medusa_db_password_secret_arn}:password::"
    JWT_SECRET    = module.secrets_manager.medusa_jwt_secret_secret_arn
    COOKIE_SECRET = module.secrets_manager.medusa_cookie_secret_secret_arn
  }

  additional_policy_json   = data.aws_iam_policy_document.medusa_task.json
  attach_additional_policy = true
}
