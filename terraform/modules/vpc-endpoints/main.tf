# Lets the private-isolated tier (RDS-only Lambdas + Directus) reach S3,
# Secrets Manager, EventBridge, CloudWatch Logs, and ECR without a NAT
# Gateway — infrastructure/networking.md. S3 is a free gateway endpoint;
# the rest are small flat-rate interface endpoints, cheaper than routing
# that traffic through NAT once more than a couple of low-volume
# functions are doing it. ecr.api/ecr.dkr were added in Phase 2 —
# Directus's ECS task is the first thing in the isolated tier that
# needs to pull a container image (Lambda deployment packages don't go
# through ECR at all, so nothing needed this before now).
#
# var.create_endpoints = false reuses pre-existing endpoints instead of
# creating new ones for whichever services genuinely already exist in
# the account's reused VPC — the S3 gateway endpoint and the
# secretsmanager interface endpoint, confirmed via a real
# `aws ec2 describe-vpc-endpoints` (this module's earlier header
# comment claimed "all six" of these pre-existed from an earlier,
# unrelated project; that turned out to be wrong for events/logs/
# ecr.api/ecr.dkr — a live Directus ECS task failing to reach ECR is
# what surfaced it. AWS allows only one private-DNS-enabled interface
# endpoint per service per VPC, so the two that DO already exist can't
# be recreated — a real apply confirmed both the gateway-endpoint route
# conflict and the secretsmanager interface-endpoint private-DNS
# conflict). The remaining services
# (var.interface_endpoints_to_create) are genuinely created by this
# module even when create_endpoints = false, using
# var.endpoint_security_group_id like the create_endpoints = true path
# does — ingress for their actual consumers lives in
# terraform/modules/security-groups, not here.

resource "aws_vpc_endpoint" "s3" {
  count = var.create_endpoints ? 1 : 0

  vpc_id            = var.vpc_id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = var.private_isolated_route_table_ids

  tags = {
    Name        = "pk-literature-${var.environment}-s3"
    Environment = var.environment
  }
}

# create_endpoints = false reuses the account's existing S3 gateway
# endpoint rather than the resource above — but nothing verified that
# reused endpoint's RouteTableIds actually included
# var.private_isolated_route_table_ids's specific table (it was created
# for an earlier, unrelated project, against whatever route table THAT
# project used). A real Directus ECS task confirmed the gap: its
# CannotPullContainerError's `dial tcp <public-ip>:443: i/o timeout`
# meant image-layer traffic to S3 wasn't being routed through the
# gateway endpoint at all. This association resource only adds a
# RouteTableIds entry to the existing endpoint — additive, doesn't
# import or otherwise take over managing it.
data "aws_vpc_endpoint" "s3" {
  count = var.create_endpoints ? 0 : 1

  vpc_id       = var.vpc_id
  service_name = "com.amazonaws.${var.aws_region}.s3"
}

resource "aws_vpc_endpoint_route_table_association" "s3_reused" {
  for_each = var.create_endpoints ? toset([]) : toset(var.private_isolated_route_table_ids)

  vpc_endpoint_id = data.aws_vpc_endpoint.s3[0].id
  route_table_id  = each.value
}

locals {
  interface_endpoint_services = [
    "secretsmanager",
    "events",
    "logs",
    "ecr.api",
    "ecr.dkr",
  ]
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(var.create_endpoints ? local.interface_endpoint_services : var.interface_endpoints_to_create)

  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.private_isolated_subnet_ids
  security_group_ids  = [var.endpoint_security_group_id]
  private_dns_enabled = true

  tags = {
    Name        = "pk-literature-${var.environment}-${each.value}"
    Environment = var.environment
  }
}

locals {
  # Every (existing endpoint security group, consumer security group)
  # pair that needs a new ingress rule when reusing endpoints this
  # config doesn't own. Empty when create_endpoints = true — nothing
  # to grant, the endpoints created above already have
  # var.endpoint_security_group_id attached directly.
  #
  # Keys come from var.existing_interface_endpoint_sg_ids (a plain list
  # of literal strings) and keys(var.consumer_security_group_ids) — a
  # map's keys are always known at plan time even when its values
  # aren't, which matters here because a brand-new consumer security
  # group's .id (e.g. migration_runner's, created in the same apply
  # this ingress rule is) is NOT known until after it's created.
  # Building the for_each key by interpolating that .id directly (the
  # previous, list(string)-typed version of this variable) hits
  # "Invalid for_each argument: will be known only after apply" the
  # first time such a resource is genuinely new — same underlying
  # Terraform limitation as modules/vpc's chained for_each fix.
  existing_endpoint_ingress_pairs = var.create_endpoints ? {} : {
    for pair in setproduct(var.existing_interface_endpoint_sg_ids, keys(var.consumer_security_group_ids)) :
    "${pair[0]}-${pair[1]}" => { endpoint_sg_id = pair[0], consumer_sg_id = var.consumer_security_group_ids[pair[1]] }
  }
}

# Additive only — grants var.consumer_security_group_ids inbound 443 on
# each pre-existing endpoint security group, without importing or
# otherwise managing that security group or its other rules (e.g.
# whatever the original project that created these endpoints already
# has permitted stays untouched).
resource "aws_vpc_security_group_ingress_rule" "existing_endpoint_access" {
  for_each = local.existing_endpoint_ingress_pairs

  security_group_id            = each.value.endpoint_sg_id
  referenced_security_group_id = each.value.consumer_sg_id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "HTTPS from pk-literature (reused VPC endpoint, not owned by this Terraform config)"
}
