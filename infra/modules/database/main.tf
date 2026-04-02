################################################################################
# DB Subnet Group
################################################################################

resource "aws_db_subnet_group" "this" {
  name       = "${var.environment}-swiftagent"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name        = "${var.environment}-swiftagent"
    Environment = var.environment
  }
}

################################################################################
# Master Password
################################################################################

resource "random_password" "master" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}|:?"
}

################################################################################
# SSM Parameters — Credentials
################################################################################

resource "aws_ssm_parameter" "master_username" {
  name  = "/${var.environment}/swiftagent/db_master_username"
  type  = "SecureString"
  value = "swiftagent_admin"

  tags = {
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "master_password" {
  name  = "/${var.environment}/swiftagent/db_master_password"
  type  = "SecureString"
  value = random_password.master.result

  tags = {
    Environment = var.environment
  }
}

################################################################################
# RDS PostgreSQL Instance
################################################################################

resource "aws_db_instance" "this" {
  identifier     = "${var.environment}-swiftagent"
  engine         = "postgres"
  engine_version = "16"

  instance_class        = var.instance_class
  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = var.db_name
  username = "swiftagent_admin"
  password = random_password.master.result

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.security_group_id]

  multi_az                = var.multi_az
  backup_retention_period = var.backup_retention_period
  publicly_accessible     = false

  skip_final_snapshot       = var.environment != "prod"
  final_snapshot_identifier = "${var.environment}-swiftagent-final"
  deletion_protection       = var.environment == "prod"

  tags = {
    Name        = "${var.environment}-swiftagent"
    Environment = var.environment
  }
}

################################################################################
# Connection String (output only — canonical SSM storage is in secrets module)
################################################################################

locals {
  connection_string = "postgresql://${aws_db_instance.this.username}:${random_password.master.result}@${aws_db_instance.this.endpoint}/${aws_db_instance.this.db_name}"
}
