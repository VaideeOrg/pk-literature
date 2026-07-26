# Phase 0 foundations — dev environment. Same module set as qa/prod,
# only .tfvars sizing differs (SPEC-12 acceptance criterion). See
# plan/implementation-blueprint/infrastructure/terraform-layout.md for
# the build order this follows and why.

module "route53_acm" {
  source = "../../modules/route53-acm"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment        = "dev"
  domain_name        = var.domain_name
  create_hosted_zone = var.create_hosted_zone
}

module "vpc" {
  source = "../../modules/vpc"

  environment        = "dev"
  azs                = var.azs
  single_nat_gateway = true # infrastructure/networking.md — single NAT to start, all envs
}

module "security_groups" {
  source = "../../modules/security-groups"

  environment = "dev"
  vpc_id      = module.vpc.vpc_id
  vpc_cidr    = module.vpc.vpc_cidr
}

module "vpc_endpoints" {
  source = "../../modules/vpc-endpoints"

  environment                      = "dev"
  vpc_id                           = module.vpc.vpc_id
  aws_region                       = var.aws_region
  private_isolated_route_table_ids = [module.vpc.private_isolated_route_table_id]
  private_isolated_subnet_ids      = module.vpc.private_isolated_subnet_ids
  endpoint_security_group_id       = module.security_groups.vpc_endpoints_sg_id
}

module "secrets_manager" {
  source = "../../modules/secrets-manager"

  environment = "dev"
}

module "rds" {
  source = "../../modules/rds"

  environment                 = "dev"
  vpc_id                      = module.vpc.vpc_id
  private_isolated_subnet_ids = module.vpc.private_isolated_subnet_ids
  rds_sg_id                   = module.security_groups.rds_sg_id
  master_username             = module.secrets_manager.rds_master_username
  master_password             = module.secrets_manager.rds_master_password

  instance_class        = "db.t4g.micro" # infrastructure/cost-estimation.md — dev sizing
  multi_az              = false
  deletion_protection   = false
  skip_final_snapshot   = true
  backup_retention_days = 7
}

module "rds_proxy" {
  source = "../../modules/rds-proxy"

  environment                 = "dev"
  private_isolated_subnet_ids = module.vpc.private_isolated_subnet_ids
  rds_proxy_sg_id             = module.security_groups.rds_proxy_sg_id
  db_instance_id              = module.rds.db_instance_id
  rds_master_secret_arn       = module.secrets_manager.rds_master_secret_arn
  require_iam_auth            = true
  # Every Lambda service's own IAM-auth DB role needs a registered
  # entry too (iam_auth = REQUIRED) — without one, the proxy has no way
  # to recognize the role at all and rejects the connection with "This
  # RDS proxy has no credentials for the role <role>", confirmed by a
  # real error from publisher_import_writer's first live invocation in
  # prod.
  iam_auth_secret_arns = values(module.secrets_manager.iam_auth_role_secret_arns)
}

module "s3" {
  source = "../../modules/s3"

  environment   = "dev"
  force_destroy = true # dev — teardown convenience, runbooks/teardown.md
}

module "cloudfront" {
  source = "../../modules/cloudfront"

  environment                       = "dev"
  domain_name                       = var.domain_name
  cloudfront_certificate_arn        = module.route53_acm.cloudfront_certificate_arn
  hosted_zone_id                    = module.route53_acm.zone_id
  media_bucket_id                   = module.s3.bucket_id
  media_bucket_arn                  = module.s3.bucket_arn
  media_bucket_regional_domain_name = module.s3.bucket_regional_domain_name
}

module "api_gateway" {
  source = "../../modules/api-gateway"

  environment              = "dev"
  domain_name              = var.domain_name
  regional_certificate_arn = module.route53_acm.regional_certificate_arn
  hosted_zone_id           = module.route53_acm.zone_id
}

module "eventbridge" {
  source = "../../modules/eventbridge"

  environment = "dev"
}

module "cloudwatch" {
  source = "../../modules/cloudwatch"

  environment     = "dev"
  rds_instance_id = module.rds.db_instance_id
  rds_proxy_name  = module.rds_proxy.proxy_name
  nat_gateway_ids = module.vpc.nat_gateway_ids
  api_gateway_id  = module.api_gateway.api_id
  alarm_email     = var.alarm_email
}
