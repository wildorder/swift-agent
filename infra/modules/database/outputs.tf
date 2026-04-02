output "endpoint" {
  description = "RDS instance endpoint (host:port)"
  value       = aws_db_instance.this.endpoint
}

output "port" {
  description = "RDS instance port"
  value       = aws_db_instance.this.port
}

output "database_name" {
  description = "Name of the default database"
  value       = aws_db_instance.this.db_name
}

output "master_username_ssm_arn" {
  description = "ARN of the SSM parameter storing the master username"
  value       = aws_ssm_parameter.master_username.arn
}

output "master_password_ssm_arn" {
  description = "ARN of the SSM parameter storing the master password"
  value       = aws_ssm_parameter.master_password.arn
}

output "connection_string" {
  description = "PostgreSQL connection string (sensitive — pass to secrets module for SSM storage)"
  value       = local.connection_string
  sensitive   = true
}
