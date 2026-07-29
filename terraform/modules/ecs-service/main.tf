# Generic reusable Fargate service module — one instantiation per admin
# surface (Directus now, Medusa in phase-6). Mirrors lambda-service's
# shape: this module supplies the boilerplate (execution role, task
# role scaffold, log group, service/task-def wiring); the environment's
# own <service>.tf supplies the image, VPC placement, and business IAM.
#
# Two IAM roles, per ECS's own model — not to be confused with each
# other: the EXECUTION role is what ECS itself uses to pull the image
# and ship logs; the TASK role is what the running container's own AWS
# SDK calls (RDS Proxy, S3, EventBridge, ...) authenticate as.

data "aws_iam_policy_document" "ecs_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "pk-literature-${var.environment}-${var.service_name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Execution role also needs to read the Secrets Manager values injected
# via `secrets` in the container definition — the managed policy above
# only covers ECR/logs, not arbitrary secrets.
#
# A caller's `secrets` value may carry a `:jsonKey::` suffix (e.g.
# directus.tf's `"${arn}:password::"`, extracting one field out of a
# JSON-shaped secret) — but the actual secretsmanager:GetSecretValue
# call ECS makes under the hood is always against the bare secret ARN,
# confirmed by a real AccessDeniedException naming the bare ARN even
# though the task definition's own valueFrom included the suffix. An
# ARN has exactly 6 colons (7 fields: arn:partition:service:region:
# account:resourcetype:resource-id); anything after that is the
# optional suffix, stripped here so this policy's Resource list
# actually matches what AWS evaluates against.
locals {
  execution_secret_arns = distinct([
    for value in values(var.secrets) : join(":", slice(split(":", value), 0, 7))
  ])
}

data "aws_iam_policy_document" "execution_secrets" {
  count = length(var.secrets) > 0 ? 1 : 0

  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.execution_secret_arns
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count = length(var.secrets) > 0 ? 1 : 0

  name   = "read-task-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets[0].json
}

resource "aws_iam_role" "task" {
  name               = "pk-literature-${var.environment}-${var.service_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

# ECS Exec's data channel runs over Session Manager, not the ECS API
# itself — the task role (not the execution role, which is only ever
# used by the ECS agent for image pull/log shipping) needs these three
# SSM actions on itself (Resource = "*" is what AWS's own documented
# ECS Exec IAM policy uses; the channel is identified by the task's own
# runtime session, not a fixed ARN known at plan time).
data "aws_iam_policy_document" "task_exec" {
  count = var.enable_execute_command ? 1 : 0

  statement {
    effect = "Allow"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task_exec" {
  count = var.enable_execute_command ? 1 : 0

  name   = "ecs-exec"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_exec[0].json
}

resource "aws_iam_role_policy" "task_additional" {
  # Deliberately gated on the caller-supplied literal boolean, not on
  # `var.additional_policy_json != null`: every real caller's policy
  # document references module.rds_proxy.iam_auth_resource_id (an
  # output derived from aws_db_proxy.this.arn), which is unknown until
  # the proxy is actually created. On a first-ever apply that makes the
  # whole `.json` value "known after apply," and Terraform can't
  # evaluate `!= null` against an unknown value at plan time — it
  # rejects the count argument outright ("Invalid count argument...
  # depends on resource attributes that cannot be determined until
  # apply"), even though every caller always supplies a real document.
  # var.attach_additional_policy is a plain literal `true`/`false` set
  # by the caller, so it's always known at plan time regardless of
  # what the policy content itself depends on.
  count = var.attach_additional_policy ? 1 : 0

  name   = "additional-permissions"
  role   = aws_iam_role.task.id
  policy = var.additional_policy_json
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/pk-literature-${var.environment}-${var.service_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "this" {
  family                   = "pk-literature-${var.environment}-${var.service_name}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = var.service_name
      image     = var.image
      essential = true
      portMappings = [
        {
          containerPort = var.container_port
          protocol      = "tcp"
        }
      ]
      environment = [
        for key, value in var.environment_variables : { name = key, value = value }
      ]
      secrets = [
        for key, arn in var.secrets : { name = key, valueFrom = arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = var.service_name
        }
      }
    }
  ])

  tags = {
    Environment = var.environment
    Service     = var.service_name
  }
}

data "aws_region" "current" {}

resource "aws_ecs_service" "this" {
  name                   = "pk-literature-${var.environment}-${var.service_name}"
  cluster                = var.cluster_id
  task_definition        = aws_ecs_task_definition.this.arn
  desired_count          = var.desired_count
  launch_type            = "FARGATE"
  enable_execute_command = var.enable_execute_command

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = var.service_name
    container_port   = var.container_port
  }

  health_check_grace_period_seconds = var.health_check_grace_period_seconds

  # Directus needs its own DB migrations to finish before a second task
  # would come up healthy anyway; keep deploys simple (recreate) rather
  # than blue/green for this single-task admin surface.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  tags = {
    Environment = var.environment
    Service     = var.service_name
  }
}
