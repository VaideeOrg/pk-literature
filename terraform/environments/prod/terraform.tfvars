# Placeholder values — set the real domain and alarm email before first
# apply. Sizing/safety flags are prod-specific (see main.tf header
# comment and infrastructure/cost-estimation.md).

aws_region         = "ap-southeast-1"
domain_name        = "puthagakadai.com" # REPLACE before first apply
create_hosted_zone = true
alarm_email        = "www.vaidee@gmail.com" # REPLACE before first apply
azs                = ["ap-southeast-1a", "ap-southeast-1b"]

# Reusing this account's existing VPC (modules/vpc's create_vpc = false
# mode, main.tf) instead of provisioning a new one — see
# variables.tf's comment for how to pull the real values.
existing_vpc_id                          = "vpc-02c8db6c3e2258401"                                  # REPLACE before first apply
existing_public_subnet_ids               = ["subnet-06b51e37246fbae4b", "subnet-005a157f3877f0c6b"] # REPLACE before first apply
existing_private_isolated_subnet_ids     = ["subnet-0ead7c717e0f7ef8e", "subnet-0b79e77d746c41a7c"] # REPLACE before first apply
existing_private_nat_subnet_ids          = ["subnet-010564041584b7678", "subnet-05526ae30e111671f"] # REPLACE before first apply
existing_private_isolated_route_table_id = "rtb-0e792ed2933373427"                                  # REPLACE before first apply
existing_nat_gateway_ids                 = []                                                       # optional — see variables.tf

# This reused VPC already has a secretsmanager interface endpoint from
# an earlier, unrelated project (main.tf's create_endpoints = false) —
# this is its security group, found via `aws ec2 describe-vpc-endpoints`.
# events/logs/ecr.api/ecr.dkr do NOT pre-exist despite an earlier,
# wrong assumption that they did (main.tf's interface_endpoints_to_create
# creates those instead). sg-03e60ba1e04d0d268 used to be listed here
# too, on that same wrong assumption — describe-vpc-endpoints confirms
# it isn't attached to any of this VPC's real endpoints, and keeping it
# caused a real terraform apply failure (InvalidSecurityGroupRuleId.NotFound)
# once its state entry collided with an unrelated resource's rule ID.
existing_interface_endpoint_sg_ids = ["sg-0893b4a98e0b5a7c9"]

# Flipped false: reopening the storefront to verify the mobile nav,
# /browse page, and homepage banner live. This comment previously
# claimed the value below was already false while it actually read
# true - the two had drifted out of sync; this edit fixes both at once.
coming_soon_mode = false
