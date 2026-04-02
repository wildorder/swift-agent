data "aws_region" "current" {}

resource "aws_ecs_task_definition" "this" {
  family                   = local.name_prefix
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.task_execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([
    {
      name      = local.name_prefix
      image     = var.image_uri
      essential = true

      portMappings = [
        {
          containerPort = 3000
          protocol      = "tcp"
        }
      ]

      secrets = [
        for key, arn in var.ssm_parameter_arns : {
          name      = key
          valueFrom = arn
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "ecs"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    }
  ])

  tags = local.tags
}
