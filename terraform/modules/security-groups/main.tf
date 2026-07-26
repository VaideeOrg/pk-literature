# Phase 0 added the DB-access chain + VPC endpoint access. Phase 2 adds
# ecs-directus-sg and alb-admin-sg below. Phase 6 adds lambda-egress-sg
# and ecs-medusa-sg, per development/branching.md's "each phase owns
# its own infra" rule.
#
# Chain: rds-sg <- rds-proxy-sg <- lambda-db-sg
# (infrastructure/networking.md)

# S3 Gateway endpoint traffic stays addressed to S3's own (AWS-owned,
# public-looking) IP range — the route table's prefix-list route
# redirects it in-flight, but there's no ENI, so a security group can't
# match it against vpc_cidr the way it can for interface-endpoint
# traffic. Every *_to_vpc_endpoints rule below is deliberately
# vpc_cidr-scoped for the interface endpoints (secretsmanager/events/
# logs/ecr.api/ecr.dkr) and needs this separate, prefix-list-scoped
# rule alongside it for S3 specifically — confirmed missing via a real
# Directus ECS task's CannotPullContainerError (a silent SG drop on the
# S3 leg of an ECR image-layer pull produces exactly the raw
# `dial tcp <ip>:443: i/o timeout` that surfaced this).
data "aws_ec2_managed_prefix_list" "s3" {
  name = "com.amazonaws.${var.aws_region}.s3"
}

resource "aws_security_group" "rds" {
  name_prefix = "pk-literature-${var.environment}-rds-"
  vpc_id      = var.vpc_id
  description = "RDS PostgreSQL - inbound only from RDS Proxy"

  tags = {
    Name        = "pk-literature-${var.environment}-rds"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "rds_proxy" {
  name_prefix = "pk-literature-${var.environment}-rds-proxy-"
  vpc_id      = var.vpc_id
  description = "RDS Proxy - inbound only from Lambda/ECS needing DB access"

  tags = {
    Name        = "pk-literature-${var.environment}-rds-proxy"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "lambda_db" {
  name_prefix = "pk-literature-${var.environment}-lambda-db-"
  vpc_id      = var.vpc_id
  description = "Attached to every Lambda/ECS task needing DB access, regardless of subnet tier"

  tags = {
    Name        = "pk-literature-${var.environment}-lambda-db"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "lambda_egress" {
  name_prefix = "pk-literature-${var.environment}-lambda-egress-"
  vpc_id      = var.vpc_id
  description = "Attached to private-nat-tier Lambdas (Commerce) needing internet egress - outbound 443 only"

  tags = {
    Name        = "pk-literature-${var.environment}-lambda-egress"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "vpc_endpoints" {
  name_prefix = "pk-literature-${var.environment}-vpc-endpoints-"
  vpc_id      = var.vpc_id
  description = "Interface VPC endpoints this config creates (ECR api/dkr, EventBridge) - inbound 443 from their actual consumers"

  tags = {
    Name        = "pk-literature-${var.environment}-vpc-endpoints"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- rds-sg: ingress 5432 from rds-proxy-sg, plus migration-runner-sg directly ---

resource "aws_vpc_security_group_ingress_rule" "rds_from_proxy" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.rds_proxy.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from RDS Proxy"
}

# ---------------------------------------------------------------------
# apps/migration-runner: the one client that connects to RDS directly,
# bypassing the proxy entirely. RDS Proxy's iam_auth = REQUIRED on the
# master secret's auth entry (modules/rds-proxy) is deliberate — RDS
# doesn't support IAM database authentication for the master user at
# all, so nothing can ever authenticate as master through that proxy,
# password or IAM. migration-runner needs the master user specifically
# (the app DB roles its own migrations grant don't exist yet on a cold
# start), so it connects straight to RDS's own endpoint instead.
# ---------------------------------------------------------------------

resource "aws_security_group" "migration_runner" {
  name_prefix = "pk-literature-${var.environment}-migration-runner-"
  vpc_id      = var.vpc_id
  description = "migration-runner Lambda - direct RDS access with the master credential, bypassing RDS Proxy"

  tags = {
    Name        = "pk-literature-${var.environment}-migration-runner"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "migration_runner_to_rds" {
  security_group_id            = aws_security_group.migration_runner.id
  referenced_security_group_id = aws_security_group.rds.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres directly to RDS (not via RDS Proxy)"
}

resource "aws_vpc_security_group_egress_rule" "migration_runner_to_vpc_endpoints" {
  security_group_id = aws_security_group.migration_runner.id
  # CIDR, not an SG reference — same reasoning as lambda_db_to_vpc_endpoints:
  # the Secrets Manager endpoint it reaches (for the master credential)
  # is a reused one this config doesn't own.
  cidr_ipv4   = var.vpc_cidr
  from_port   = 443
  to_port     = 443
  ip_protocol = "tcp"
  description = "HTTPS to Secrets Manager (RDS master credential)"
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_migration_runner" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.migration_runner.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from migration-runner Lambda, direct (not via RDS Proxy)"
}

# --- rds-proxy-sg: ingress 5432 from lambda-db-sg/ecs-directus-sg/ecs-medusa-sg; egress 5432 to rds-sg ---

resource "aws_vpc_security_group_ingress_rule" "rds_proxy_from_lambda_db" {
  security_group_id            = aws_security_group.rds_proxy.id
  referenced_security_group_id = aws_security_group.lambda_db.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from Lambda DB clients"
}

# Directus and Medusa each have their own dedicated security group
# (ecs_directus/ecs_medusa below), not lambda_db — each one's own
# *_to_rds_proxy egress rule only covers its half of the connection;
# without a matching ingress rule here, RDS Proxy's security group
# silently drops the inbound attempt (no RST), which is exactly what
# produces Knex's "Timeout acquiring a connection" rather than a clean
# connection-refused/auth error — a live Medusa ECS task crash-looping
# on this exact symptom is what surfaced the gap.
resource "aws_vpc_security_group_ingress_rule" "rds_proxy_from_ecs_directus" {
  security_group_id            = aws_security_group.rds_proxy.id
  referenced_security_group_id = aws_security_group.ecs_directus.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from Directus ECS task"
}

resource "aws_vpc_security_group_ingress_rule" "rds_proxy_from_ecs_medusa" {
  security_group_id            = aws_security_group.rds_proxy.id
  referenced_security_group_id = aws_security_group.ecs_medusa.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from Medusa ECS task"
}

resource "aws_vpc_security_group_egress_rule" "rds_proxy_to_rds" {
  security_group_id            = aws_security_group.rds_proxy.id
  referenced_security_group_id = aws_security_group.rds.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres to RDS"
}

# --- lambda-db-sg: egress 5432 to rds-proxy-sg, egress 443 to vpc-endpoints-sg ---

resource "aws_vpc_security_group_egress_rule" "lambda_db_to_rds_proxy" {
  security_group_id            = aws_security_group.lambda_db.id
  referenced_security_group_id = aws_security_group.rds_proxy.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres to RDS Proxy"
}

resource "aws_vpc_security_group_egress_rule" "lambda_db_to_s3" {
  security_group_id = aws_security_group.lambda_db.id
  # See the module-level comment above data.aws_ec2_managed_prefix_list.s3
  # — api-publisher-import's cover uploads (MEDIA_BUCKET_NAME) are the
  # one thing in this SG's consumers that actually needs S3 today, but
  # this SG is shared by every private-isolated-tier Lambda, so fixing
  # it here rather than narrowly on api-publisher-import matches how
  # the rest of this SG's rules are already structured.
  prefix_list_id = data.aws_ec2_managed_prefix_list.s3.id
  from_port      = 443
  to_port        = 443
  ip_protocol    = "tcp"
  description    = "HTTPS to S3 gateway endpoint"
}

resource "aws_vpc_security_group_egress_rule" "lambda_db_to_vpc_endpoints" {
  security_group_id = aws_security_group.lambda_db.id
  # CIDR, not a security-group reference: modules/vpc-endpoints' interface
  # endpoints may be ones this Terraform config reuses rather than
  # creates (create_endpoints = false), in which case they sit behind a
  # security group this config doesn't manage. VPC-CIDR-scoped HTTPS
  # egress works the same either way.
  cidr_ipv4   = var.vpc_cidr
  from_port   = 443
  to_port     = 443
  ip_protocol = "tcp"
  description = "HTTPS to Secrets Manager/EventBridge/CloudWatch Logs interface endpoints"
}

# --- lambda-egress-sg: egress 443 to the internet (via NAT), egress 5432 to rds-proxy-sg ---

resource "aws_vpc_security_group_egress_rule" "lambda_egress_to_internet" {
  security_group_id = aws_security_group.lambda_egress.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS egress (Razorpay) via NAT Gateway"
}

resource "aws_vpc_security_group_egress_rule" "lambda_egress_to_rds_proxy" {
  security_group_id            = aws_security_group.lambda_egress.id
  referenced_security_group_id = aws_security_group.rds_proxy.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres to RDS Proxy (Commerce Lambda needs both DB and Razorpay)"
}

# --- vpc-endpoints-sg: ingress 443 from every consumer of the
# ecr.api/ecr.dkr/events interface endpoints this SG fronts
# (terraform/environments/prod/main.tf's interface_endpoints_to_create
# — the ones genuinely created by this Terraform config, as opposed to
# the reused secretsmanager/S3 endpoints owned by another project's
# security groups). ecs_directus/ecs_medusa need ECR (image pull +
# registry auth) and events (their own direct PutEvents callers);
# lambda_db covers every private-isolated Lambda's own PutEvents calls
# (api-identity/api-publisher-import); lambda_egress covers
# api-commerce's. Medusa/api-commerce also have real internet egress
# via NAT, but that doesn't substitute for this: interface endpoints'
# private DNS overrides the public hostname for every resource in the
# VPC once the endpoint exists, regardless of which subnet/NAT
# configuration the caller sits in — confirmed directly by Directus's
# ECS task timing out against ECR's public IP before these endpoints
# existed at all. ---

resource "aws_vpc_security_group_ingress_rule" "vpc_endpoints_from_lambda_db" {
  security_group_id            = aws_security_group.vpc_endpoints.id
  referenced_security_group_id = aws_security_group.lambda_db.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "HTTPS from private-isolated-tier Lambda/ECS clients"
}

resource "aws_vpc_security_group_ingress_rule" "vpc_endpoints_from_lambda_egress" {
  security_group_id            = aws_security_group.vpc_endpoints.id
  referenced_security_group_id = aws_security_group.lambda_egress.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "HTTPS from private-nat-tier Lambda (api-commerce PutEvents calls)"
}

# ---------------------------------------------------------------------
# Phase 2: Directus admin ALB + ECS task. Directus sits in the
# private-isolated tier (ADR-009 — nothing in its runtime needs the
# internet; image pulls happen at deploy time via VPC endpoints /
# ECR, not runtime egress), fronted by a public-subnet ALB.
# ---------------------------------------------------------------------

resource "aws_security_group" "alb_admin" {
  name_prefix = "pk-literature-${var.environment}-alb-admin-"
  vpc_id      = var.vpc_id
  description = "Admin ALB (Directus, Medusa) - public HTTPS ingress only"

  tags = {
    Name        = "pk-literature-${var.environment}-alb-admin"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "ecs_directus" {
  name_prefix = "pk-literature-${var.environment}-ecs-directus-"
  vpc_id      = var.vpc_id
  description = "Directus ECS task - inbound only from the admin ALB"

  tags = {
    Name        = "pk-literature-${var.environment}-ecs-directus"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_admin_from_internet" {
  security_group_id = aws_security_group.alb_admin.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS from the internet - editorial access is gated by Directus login, not this rule"
}

resource "aws_vpc_security_group_egress_rule" "alb_admin_to_ecs_directus" {
  security_group_id            = aws_security_group.alb_admin.id
  referenced_security_group_id = aws_security_group.ecs_directus.id
  from_port                    = 8055
  to_port                      = 8055
  ip_protocol                  = "tcp"
  description                  = "Directus container port"
}

resource "aws_vpc_security_group_ingress_rule" "ecs_directus_from_alb" {
  security_group_id            = aws_security_group.ecs_directus.id
  referenced_security_group_id = aws_security_group.alb_admin.id
  from_port                    = 8055
  to_port                      = 8055
  ip_protocol                  = "tcp"
  description                  = "Directus container port from the admin ALB"
}

resource "aws_vpc_security_group_egress_rule" "ecs_directus_to_rds_proxy" {
  security_group_id            = aws_security_group.ecs_directus.id
  referenced_security_group_id = aws_security_group.rds_proxy.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres to RDS Proxy"
}

resource "aws_vpc_security_group_egress_rule" "ecs_directus_to_vpc_endpoints" {
  security_group_id = aws_security_group.ecs_directus.id
  # Same reasoning as lambda_db_to_vpc_endpoints above — CIDR, not an
  # SG reference, since the endpoints may be reused/unmanaged ones.
  cidr_ipv4   = var.vpc_cidr
  from_port   = 443
  to_port     = 443
  ip_protocol = "tcp"
  description = "HTTPS to Secrets Manager/EventBridge/ECR interface endpoints"
}

resource "aws_vpc_security_group_egress_rule" "ecs_directus_to_s3" {
  security_group_id = aws_security_group.ecs_directus.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.s3.id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS to S3 gateway endpoint (ECR image-layer pulls)"
}

resource "aws_vpc_security_group_ingress_rule" "vpc_endpoints_from_ecs_directus" {
  security_group_id            = aws_security_group.vpc_endpoints.id
  referenced_security_group_id = aws_security_group.ecs_directus.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "HTTPS from Directus ECS task (ECR image pull/registry auth, its own PutEvents calls)"
}

# ---------------------------------------------------------------------
# Phase 6: Medusa ECS task. Unlike ecs-directus (private-isolated, no
# internet route), this one lives in the private-nat tier — it's the
# other half of ADR-009's "NAT Gateway tier: shrinks to {commerce,
# Medusa}" (alongside lambda-api-commerce), needing real internet
# egress to reach Razorpay for refunds (SPEC-06's "Medusa
# Responsibilities: Refunds"). Egress rules mirror lambda-egress-sg
# rather than ecs-directus-sg's vpc-endpoints-sg egress — the NAT
# Gateway route handles Secrets Manager/EventBridge/ECR reachability
# for anything already routed to the internet, so no separate
# vpc-endpoints-sg egress is needed here (same reasoning as
# lambda-egress-sg, which has no vpc-endpoints-sg rule either).
# ---------------------------------------------------------------------

resource "aws_security_group" "ecs_medusa" {
  name_prefix = "pk-literature-${var.environment}-ecs-medusa-"
  vpc_id      = var.vpc_id
  description = "Medusa ECS task - inbound from the admin ALB, outbound internet egress for Razorpay"

  tags = {
    Name        = "pk-literature-${var.environment}-ecs-medusa"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "alb_admin_to_ecs_medusa" {
  security_group_id            = aws_security_group.alb_admin.id
  referenced_security_group_id = aws_security_group.ecs_medusa.id
  from_port                    = 9000
  to_port                      = 9000
  ip_protocol                  = "tcp"
  description                  = "Medusa container port"
}

resource "aws_vpc_security_group_ingress_rule" "ecs_medusa_from_alb" {
  security_group_id            = aws_security_group.ecs_medusa.id
  referenced_security_group_id = aws_security_group.alb_admin.id
  from_port                    = 9000
  to_port                      = 9000
  ip_protocol                  = "tcp"
  description                  = "Medusa container port from the admin ALB"
}

resource "aws_vpc_security_group_egress_rule" "ecs_medusa_to_rds_proxy" {
  security_group_id            = aws_security_group.ecs_medusa.id
  referenced_security_group_id = aws_security_group.rds_proxy.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres to RDS Proxy"
}

resource "aws_vpc_security_group_egress_rule" "ecs_medusa_to_internet" {
  security_group_id = aws_security_group.ecs_medusa.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS egress (Razorpay, Secrets Manager, EventBridge, ECR) via NAT Gateway"
}

# NAT gives Medusa real internet egress, but that alone doesn't reach
# ecr.api/ecr.dkr/events once those interface endpoints exist: private
# DNS overrides the public hostname for every VPC resource regardless
# of subnet, so Medusa's own calls get redirected here too and need
# this ingress rule the same as Directus's.
resource "aws_vpc_security_group_ingress_rule" "vpc_endpoints_from_ecs_medusa" {
  security_group_id            = aws_security_group.vpc_endpoints.id
  referenced_security_group_id = aws_security_group.ecs_medusa.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "HTTPS from Medusa ECS task (ECR image pull/registry auth, its own PutEvents calls)"
}
