variable "environment" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  description = "Egress rules to the VPC endpoints use this (not a security-group reference) because the endpoints may be ones this Terraform config doesn't own/create (modules/vpc-endpoints' create_endpoints = false path reuses pre-existing endpoints with their own, unmanaged security groups) — a CIDR-scoped rule works the same regardless of which security group actually sits on the destination ENI."
  type        = string
}

variable "aws_region" {
  description = "Used to look up the S3 gateway endpoint's managed prefix list — S3 gateway-endpoint traffic stays addressed to S3's real (AWS-owned) IP range, so a vpc_cidr-scoped egress rule (correct for interface endpoints) never matches it and silently drops it."
  type        = string
}
