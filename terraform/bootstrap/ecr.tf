# Shared across environments — the same image is promoted dev -> qa ->
# prod, so this isn't per-environment (terraform-layout.md). Directus's
# ECS task pulls from here, not Docker Hub directly: it lives in the
# private-isolated subnet tier (ADR-009, no NAT), so a CI step mirrors
# the official directus/directus image into this repo (CI runners have
# normal internet access; the running ECS task does not need any).

resource "aws_ecr_repository" "directus" {
  name                 = "pk-literature/directus"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "directus" {
  repository = aws_ecr_repository.directus.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}

# Medusa (SPEC-06) — unlike Directus, there is no official pre-built
# image to mirror; apps/medusa/Dockerfile builds the whole server+admin
# image from source. Still pushed here (not built at deploy time) so
# ECS task definitions reference an immutable, already-built tag, same
# as Directus. terraform/environments/<env>/medusa.tf's ECS task sits
# in the private-nat tier (ADR-009: "{commerce, Medusa}"), so the
# *running* task still never needs to reach Docker Hub or npm directly
# — only .github/workflows/build-medusa-image.yml's CI runner does.

resource "aws_ecr_repository" "medusa" {
  name                 = "pk-literature/medusa"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "medusa" {
  repository = aws_ecr_repository.medusa.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}

# ai-service (AI Tamil Bookseller spec) — like Medusa, no upstream image
# to layer onto; .github/workflows/build-ai-service-image.yml builds
# ai-service/Dockerfile from source and pushes here. The EC2 host
# (terraform/environments/prod/ai-bookseller-ec2.tf) pulls from here at
# boot/update (ec2-bootstrap.sh/deploy.sh) — it never needs to reach
# Docker Hub itself, same "CI runner is the one internet-facing build
# step" reasoning as Medusa's own comment above, even though this host
# sits in the private-nat tier anyway (for the model/weights S3 pull,
# not for this).
resource "aws_ecr_repository" "ai_service" {
  name                 = "pk-literature/ai-service"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "ai_service" {
  repository = aws_ecr_repository.ai_service.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}
