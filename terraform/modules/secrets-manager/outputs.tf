output "rds_master_secret_arn" {
  value = aws_secretsmanager_secret.rds_master.arn
}

output "rds_master_username" {
  value = var.rds_master_username
}

output "rds_master_password" {
  value     = random_password.rds_master.result
  sensitive = true
}

output "directus_db_username" {
  value = var.directus_db_username
}

output "directus_db_password_secret_arn" {
  value = aws_secretsmanager_secret.directus_db.arn
}

output "directus_key_secret_arn" {
  value = aws_secretsmanager_secret.directus_key.arn
}

output "directus_secret_secret_arn" {
  value = aws_secretsmanager_secret.directus_secret.arn
}

output "directus_admin_email" {
  value = var.directus_admin_email
}

output "directus_admin_password_secret_arn" {
  value = aws_secretsmanager_secret.directus_admin.arn
}

output "razorpay_key_id_secret_arn" {
  value = aws_secretsmanager_secret.razorpay_key_id.arn
}

output "razorpay_key_secret_secret_arn" {
  value = aws_secretsmanager_secret.razorpay_key_secret.arn
}

output "razorpay_webhook_secret_secret_arn" {
  value = aws_secretsmanager_secret.razorpay_webhook_secret.arn
}

output "inventory_webhook_secret_secret_arn" {
  value = aws_secretsmanager_secret.inventory_webhook_secret.arn
}

output "medusa_db_username" {
  value = var.medusa_db_username
}

output "medusa_db_password_secret_arn" {
  value = aws_secretsmanager_secret.medusa_db.arn
}

output "medusa_jwt_secret_secret_arn" {
  value = aws_secretsmanager_secret.medusa_jwt_secret.arn
}

output "medusa_cookie_secret_secret_arn" {
  value = aws_secretsmanager_secret.medusa_cookie_secret.arn
}

output "medusa_admin_email" {
  value = var.medusa_admin_email
}

output "medusa_admin_password_secret_arn" {
  value = aws_secretsmanager_secret.medusa_admin.arn
}

output "identity_jwt_signing_secret_arn" {
  value = aws_secretsmanager_secret.identity_jwt_signing_secret.arn
}

output "ai_bookseller_internal_token_secret_arn" {
  value = aws_secretsmanager_secret.ai_bookseller_internal_token.arn
}

# role name -> its RDS Proxy auth-registration secret ARN — feeds
# straight into rds-proxy's iam_auth_secret_arns (values(...)).
output "iam_auth_role_secret_arns" {
  value = { for role, secret in aws_secretsmanager_secret.iam_auth_role : role => secret.arn }
}
