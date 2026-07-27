output "rds_sg_id" {
  value = aws_security_group.rds.id
}

output "rds_proxy_sg_id" {
  value = aws_security_group.rds_proxy.id
}

output "lambda_db_sg_id" {
  value = aws_security_group.lambda_db.id
}

output "lambda_egress_sg_id" {
  value = aws_security_group.lambda_egress.id
}

output "vpc_endpoints_sg_id" {
  value = aws_security_group.vpc_endpoints.id
}

output "alb_admin_sg_id" {
  value = aws_security_group.alb_admin.id
}

output "ecs_directus_sg_id" {
  value = aws_security_group.ecs_directus.id
}

output "ecs_medusa_sg_id" {
  value = aws_security_group.ecs_medusa.id
}

output "migration_runner_sg_id" {
  value = aws_security_group.migration_runner.id
}

output "cloudshell_db_access_sg_id" {
  description = "Select this as the security group when creating an AWS CloudShell VPC environment for ad-hoc DB access — it's pre-wired with egress to RDS Proxy on 5432."
  value       = aws_security_group.cloudshell_db_access.id
}
