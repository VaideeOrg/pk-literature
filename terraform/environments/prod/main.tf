# Phase 0 foundations — prod environment. Same module set as dev/qa,
# only sizing/safety flags differ (SPEC-12 acceptance criterion). See
# plan/implementation-blueprint/infrastructure/terraform-layout.md for
# the build order this follows and why.
#
# Safety flags that differ from dev/qa, all per
# infrastructure/cost-estimation.md and runbooks/backup.md:
#   - instance_class: db.t4g.medium, not micro
#   - deletion_protection: true (RDS resource-level guard, independent
#     of the Terraform-state-level protections in terraform/bootstrap/)
#   - skip_final_snapshot: false (a destroy must always leave a snapshot)
#   - s3 force_destroy: false (a destroy against non-empty media fails
#     loudly instead of silently deleting uploaded covers)
#   - backup_retention_days: 30, not 7

module "route53_acm" {
  source = "../../modules/route53-acm"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment        = "prod"
  domain_name        = var.domain_name
  create_hosted_zone = var.create_hosted_zone
}

module "vpc" {
  source = "../../modules/vpc"

  environment = "prod"
  azs         = var.azs

  # Reusing this AWS account's existing VPC instead of provisioning a
  # new one — see variables.tf's existing_* variables (REPLACE their
  # placeholders before first apply) and modules/vpc's create_vpc
  # variable for the full rationale.
  create_vpc                               = false
  existing_vpc_id                          = var.existing_vpc_id
  existing_public_subnet_ids               = var.existing_public_subnet_ids
  existing_private_isolated_subnet_ids     = var.existing_private_isolated_subnet_ids
  existing_private_nat_subnet_ids          = var.existing_private_nat_subnet_ids
  existing_private_isolated_route_table_id = var.existing_private_isolated_route_table_id
  existing_nat_gateway_ids                 = var.existing_nat_gateway_ids
}

module "security_groups" {
  source = "../../modules/security-groups"

  environment = "prod"
  vpc_id      = module.vpc.vpc_id
  vpc_cidr    = module.vpc.vpc_cidr
}

module "vpc_endpoints" {
  source = "../../modules/vpc-endpoints"

  environment                      = "prod"
  vpc_id                           = module.vpc.vpc_id
  aws_region                       = var.aws_region
  private_isolated_route_table_ids = [module.vpc.private_isolated_route_table_id]
  private_isolated_subnet_ids      = module.vpc.private_isolated_subnet_ids
  endpoint_security_group_id       = module.security_groups.vpc_endpoints_sg_id

  # This account's reused VPC (main.tf's "existing VPC" module.vpc call)
  # only actually has the S3 gateway endpoint and the secretsmanager
  # interface endpoint from an earlier, unrelated project — confirmed
  # via a real `aws ec2 describe-vpc-endpoints` after Directus's ECS
  # task failed to reach ECR at all (no NAT, and no ecr.api endpoint
  # either). events/logs/ecr.api/ecr.dkr were never actually there
  # despite this file's old comment claiming "all six" pre-existed; see
  # modules/vpc-endpoints' header comment for the corrected story.
  create_endpoints = false
  # ecr.api/ecr.dkr: Directus's and Medusa's ECS tasks both need these
  # to pull their images / fetch registry auth. events: Directus's
  # eventbridge-put-event extension, Medusa's eventbridge-order-placed
  # subscriber, and api-identity/api-commerce/api-publisher-import's
  # own eventbridge.service.ts all call PutEvents directly. logs was
  # previously left out on the theory that nothing here calls the
  # CloudWatch Logs API directly — true for Lambda (its log shipping is
  # handled by the Lambda service control plane, outside the function's
  # own VPC networking) but wrong for Directus's Fargate task: the
  # awslogs log driver runs inside the task's own network namespace and
  # needs real connectivity to the Logs API to create/write its log
  # stream. Confirmed by a real stopped task's stoppedReason:
  # "ResourceInitializationError: failed to validate logger args: The
  # task cannot find the Amazon CloudWatch log group... There is a
  # connection issue between the task and Amazon CloudWatch" — with no
  # NAT in private-isolated and no logs endpoint, there was truly no
  # route there at all.
  interface_endpoints_to_create      = ["ecr.api", "ecr.dkr", "events", "logs"]
  existing_interface_endpoint_sg_ids = var.existing_interface_endpoint_sg_ids
  # ecs_medusa_sg and lambda_egress_sg were both missing here originally
  # — Medusa's and api-commerce's tasks sit outside private-isolated
  # (medusa.tf/api-commerce.tf), but the reused secretsmanager
  # endpoint's private DNS still redirects
  # secretsmanager.<region>.amazonaws.com to the endpoint ENI for every
  # resource in the VPC regardless of subnet, so NAT egress doesn't
  # help: without an ingress rule on the endpoint's security group,
  # GetSecretValue calls time out ("ResourceInitializationError: ...
  # context deadline exceeded") instead of ever reaching the internet.
  #
  # A map, not a list — modules/vpc-endpoints' for_each needs a
  # plan-time-known key for each entry, and migration_runner_sg_id is a
  # brand-new security group's .id in the same apply that first added
  # it here, which isn't known until after it's created ("Invalid
  # for_each argument: will be known only after apply", a real error
  # from that exact apply). The map's keys are plain strings this file
  # writes, known regardless of whether the values are still deferred.
  consumer_security_group_ids = {
    lambda_db        = module.security_groups.lambda_db_sg_id
    lambda_egress    = module.security_groups.lambda_egress_sg_id
    ecs_directus     = module.security_groups.ecs_directus_sg_id
    ecs_medusa       = module.security_groups.ecs_medusa_sg_id
    migration_runner = module.security_groups.migration_runner_sg_id
  }
}

module "secrets_manager" {
  source = "../../modules/secrets-manager"

  environment = "prod"
}

module "rds" {
  source = "../../modules/rds"

  environment                 = "prod"
  vpc_id                      = module.vpc.vpc_id
  private_isolated_subnet_ids = module.vpc.private_isolated_subnet_ids
  rds_sg_id                   = module.security_groups.rds_sg_id
  master_username             = module.secrets_manager.rds_master_username
  master_password             = module.secrets_manager.rds_master_password

  instance_class        = "db.t4g.medium" # infrastructure/cost-estimation.md — prod sizing
  multi_az              = false           # no Multi-AZ yet — revisit once uptime requirements justify it
  deletion_protection   = true
  skip_final_snapshot   = false
  backup_retention_days = 30
}

module "rds_proxy" {
  source = "../../modules/rds-proxy"

  environment                 = "prod"
  private_isolated_subnet_ids = module.vpc.private_isolated_subnet_ids
  rds_proxy_sg_id             = module.security_groups.rds_proxy_sg_id
  db_instance_id              = module.rds.db_instance_id
  rds_master_secret_arn       = module.secrets_manager.rds_master_secret_arn
  require_iam_auth            = true
  # Directus/Medusa connect with their own stored password (Knex has no
  # dynamic IAM token refresh) — without registering their secrets
  # here, the proxy has no auth entry for directus_app/medusa_app at
  # all and rejects them, confirmed by a real "IAM authentication
  # failed" error surfacing this gap.
  additional_auth_secret_arns = [
    module.secrets_manager.directus_db_password_secret_arn,
    module.secrets_manager.medusa_db_password_secret_arn,
  ]
}

module "s3" {
  source = "../../modules/s3"

  environment   = "prod"
  force_destroy = false # never true for prod — runbooks/teardown.md
}

module "cloudfront" {
  source = "../../modules/cloudfront"

  environment                       = "prod"
  domain_name                       = var.domain_name
  cloudfront_certificate_arn        = module.route53_acm.cloudfront_certificate_arn
  hosted_zone_id                    = module.route53_acm.zone_id
  media_bucket_id                   = module.s3.bucket_id
  media_bucket_arn                  = module.s3.bucket_arn
  media_bucket_regional_domain_name = module.s3.bucket_regional_domain_name
}

module "api_gateway" {
  source = "../../modules/api-gateway"

  environment              = "prod"
  domain_name              = var.domain_name
  regional_certificate_arn = module.route53_acm.regional_certificate_arn
  hosted_zone_id           = module.route53_acm.zone_id
}

module "eventbridge" {
  source = "../../modules/eventbridge"

  environment = "prod"
}

module "cloudwatch" {
  source = "../../modules/cloudwatch"

  environment     = "prod"
  rds_instance_id = module.rds.db_instance_id
  rds_proxy_name  = module.rds_proxy.proxy_name
  nat_gateway_ids = module.vpc.nat_gateway_ids
  api_gateway_id  = module.api_gateway.api_id
  alarm_email     = var.alarm_email
}
