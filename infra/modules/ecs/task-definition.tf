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
      name        = local.name_prefix
      image       = var.image_uri
      essential   = true
      stopTimeout = var.stop_timeout

      portMappings = [
        {
          containerPort = 3000
          protocol      = "tcp"
        }
      ]

      # Plain (non-secret) environment. DEPLOY_ENV is ALWAYS injected as the
      # environment name — it is the cloud signal the server's startup guard
      # reads (WS-32) to enforce a real wss:// PUBLIC_WEBSOCKET_URL. It is not a
      # secret, so it needs no SSM param.
      #
      # MIGRATE_SKIP_DRIFT_CHECK is concatenated in ONLY when non-empty so it is
      # absent from the task def in normal operation (default ""). It is a
      # migrate-CLI escape hatch for the reconciliation path, inert for the
      # running server — see var.migrate_skip_drift_check and
      # docs/runbooks/migrations.md.
      environment = concat(
        [
          {
            name  = "DEPLOY_ENV"
            value = var.environment
          }
        ],
        var.migrate_skip_drift_check != "" ? [
          {
            name  = "MIGRATE_SKIP_DRIFT_CHECK"
            value = var.migrate_skip_drift_check
          }
        ] : [],
        # Only for a domainless env (dev) whose ALB has no TLS listener — lets
        # the startup guard accept a ws:// PUBLIC_WEBSOCKET_URL. Absent (strict
        # wss:// only) for staging/prod.
        var.public_ws_allow_insecure ? [
          {
            name  = "PUBLIC_WS_ALLOW_INSECURE"
            value = "true"
          }
        ] : []
      )

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
        # busybox wget, NOT curl: the image is node:22-alpine, which ships no
        # curl — `curl -f …` exits 127 (not found), so this check could never
        # pass and every task was marked UNHEALTHY while serving traffic fine.
        # 127.0.0.1, NOT localhost: the server binds 0.0.0.0 (IPv4 only) and
        # alpine resolves localhost to ::1 first, which would refuse.
        command     = ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    }
  ])

  tags = local.tags
}
