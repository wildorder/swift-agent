data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ------------------------------------------------------------------------------
# ECS Task Execution Role
# ------------------------------------------------------------------------------

resource "aws_iam_role" "ecs_task_execution" {
  name = "swiftagent-${var.environment}-ecs-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_managed" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_ssm_access" {
  name = "ssm-parameter-access"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameters",
          "ssm:GetParameter"
        ]
        Resource = var.ssm_parameter_arns
      }
    ]
  })
}

resource "aws_iam_role_policy" "ecs_ecr_access" {
  name = "ecr-image-pull"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage"
        ]
        Resource = var.ecr_repository_arn
      },
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy" "ecs_logs" {
  name = "cloudwatch-logs"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      }
    ]
  })
}

# ------------------------------------------------------------------------------
# ECS Task Role (application-level permissions — minimal for MVP)
# ------------------------------------------------------------------------------

resource "aws_iam_role" "ecs_task" {
  name = "swiftagent-${var.environment}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ------------------------------------------------------------------------------
# GitHub Actions OIDC Provider (account-global — looked up, not created)
# ------------------------------------------------------------------------------

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

# ------------------------------------------------------------------------------
# Deploy Roles (one per environment, federated via GitHub OIDC)
# ------------------------------------------------------------------------------

locals {
  deploy_envs = {
    dev     = "refs/heads/dev"
    staging = "refs/heads/staging"
    prod    = "refs/heads/main"
  }
  prod_tag_ref = "refs/tags/v*"
}

resource "aws_iam_role" "deploy" {
  for_each = local.deploy_envs

  name = "swiftagent-deploy-${each.key}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = data.aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            "token.actions.githubusercontent.com:sub" = each.key == "prod" ? [
              "repo:${var.github_org}/${var.github_repo}:ref:${each.value}",
              "repo:${var.github_org}/${var.github_repo}:ref:${local.prod_tag_ref}"
            ] : ["repo:${var.github_org}/${var.github_repo}:ref:${each.value}"]
          }
        }
      }
    ]
  })

  tags = {
    Environment = each.key
    ManagedBy   = "terraform"
  }
}

resource "aws_iam_role_policy" "deploy" {
  for_each = local.deploy_envs

  name = "deploy-permissions"
  role = aws_iam_role.deploy[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        # ECR push
        {
          Effect = "Allow"
          Action = [
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
            "ecr:BatchCheckLayerAvailability",
            "ecr:PutImage",
            "ecr:InitiateLayerUpload",
            "ecr:UploadLayerPart",
            "ecr:CompleteLayerUpload"
          ]
          Resource = var.ecr_repository_arn
        },
        {
          Effect   = "Allow"
          Action   = "ecr:GetAuthorizationToken"
          Resource = "*"
        },
        # ECS deploy
        {
          Effect = "Allow"
          Action = [
            "ecs:UpdateService",
            "ecs:DescribeServices",
            "ecs:RunTask",
            "ecs:DescribeTasks"
          ]
          Resource = "*"
        },
        # S3 Terraform state
        {
          Effect = "Allow"
          Action = [
            "s3:GetObject",
            "s3:PutObject",
            "s3:ListBucket"
          ]
          Resource = [
            var.state_bucket_arn,
            "${var.state_bucket_arn}/*"
          ]
        },
        # DynamoDB lock table
        {
          Effect = "Allow"
          Action = [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:DeleteItem"
          ]
          Resource = var.lock_table_arn
        }
      ],
      # Prod-only: RDS snapshot before deploy
      each.key == "prod" ? [
        {
          Effect   = "Allow"
          Action   = "rds:CreateDBSnapshot"
          Resource = "*"
        }
      ] : []
    )
  })
}
