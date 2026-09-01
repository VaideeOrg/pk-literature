# AI Tamil Bookseller feature — the EC2 host running Gemma 2B + Whisper
# Tiny (ai-service/). First EC2 instance in this repo (everything else
# is Lambda or ECS Fargate) — see ai-service/README.md's own header for
# why this one genuinely needs to be a long-lived host rather than
# either of those. Added in its own file per development/branching.md
# ("each phase owns its own infra"), alongside api-ai-bookseller.tf.

locals {
  ai_service_ecr_repository_url = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com/pk-literature/ai-service"
}

data "aws_ami" "ubuntu_2204" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# Small deploy-time assets only (the bootstrap script + docker-compose.yml,
# a few KB total) — kept separate from the models bucket below so
# force_destroy is safe here (these are just copies of checked-in repo
# files, trivially reproducible) but never on the models bucket (a
# human-uploaded, non-reproducible-from-this-repo ~6GB artifact).
resource "aws_s3_bucket" "ai_bookseller_assets" {
  bucket_prefix = "pk-literature-${var.environment}-ai-bookseller-assets-"
  force_destroy = true

  tags = {
    Environment = var.environment
  }
}

resource "aws_s3_object" "ec2_bootstrap_script" {
  bucket = aws_s3_bucket.ai_bookseller_assets.id
  key    = "scripts/ec2-bootstrap.sh"
  source = "${path.module}/../../../ai-service/scripts/ec2-bootstrap.sh"
  etag   = filemd5("${path.module}/../../../ai-service/scripts/ec2-bootstrap.sh")
}

resource "aws_s3_object" "docker_compose_file" {
  bucket = aws_s3_bucket.ai_bookseller_assets.id
  key    = "docker-compose.yml"
  source = "${path.module}/../../../ai-service/docker-compose.yml"
  etag   = filemd5("${path.module}/../../../ai-service/docker-compose.yml")
}

# Model weights bucket. Terraform only creates the bucket — the actual
# ~5-6GB Gemma 2B GGUF is NOT something this repo or CI can produce
# (it's downloaded from HuggingFace, a third-party artifact), same
# "Terraform can't generate this, a human sets it once" situation as
# secrets-manager.tf's Razorpay placeholders. Upload once before first
# ai_bookseller instance launch:
#   aws s3 cp gemma-2b.Q4_K_M.gguf s3://<this-bucket>/gemma-2b.gguf
resource "aws_s3_bucket" "ai_bookseller_models" {
  bucket_prefix = "pk-literature-${var.environment}-ai-bookseller-models-"
  # No force_destroy: unlike the assets bucket above, this is NOT
  # reproducible from this repo alone - an accidental `terraform destroy`
  # shouldn't silently take a multi-GB human-uploaded artifact with it.

  tags = {
    Environment = var.environment
  }
}

data "aws_iam_policy_document" "ai_bookseller_ec2_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ai_bookseller_ec2" {
  name               = "pk-literature-${var.environment}-ai-bookseller-ec2"
  assume_role_policy = data.aws_iam_policy_document.ai_bookseller_ec2_assume_role.json
}

# SSM Session Manager access - no SSH key, no public IP, no port 22
# ingress anywhere in this security group. Matches this repo's existing
# "CloudShell VPC environment" ad-hoc-access pattern (security-groups'
# cloudshell_db_access) in spirit: prefer AWS-managed, IAM-audited
# access over a standing SSH surface.
resource "aws_iam_role_policy_attachment" "ai_bookseller_ec2_ssm" {
  role       = aws_iam_role.ai_bookseller_ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "ai_bookseller_ec2_permissions" {
  statement {
    sid       = "PullAiServiceImage"
    effect    = "Allow"
    actions   = ["ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability"]
    resources = ["arn:aws:ecr:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:repository/pk-literature/ai-service"]
  }

  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # GetAuthorizationToken doesn't support resource-level scoping
  }

  statement {
    sid       = "ReadAssetsAndModels"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.ai_bookseller_assets.arn}/*", "${aws_s3_bucket.ai_bookseller_models.arn}/*"]
  }

  statement {
    sid       = "ReadInternalToken"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets_manager.ai_bookseller_internal_token_secret_arn]
  }
}

resource "aws_iam_role_policy" "ai_bookseller_ec2_permissions" {
  name   = "ai-bookseller-permissions"
  role   = aws_iam_role.ai_bookseller_ec2.id
  policy = data.aws_iam_policy_document.ai_bookseller_ec2_permissions.json
}

resource "aws_iam_instance_profile" "ai_bookseller_ec2" {
  name = "pk-literature-${var.environment}-ai-bookseller-ec2"
  role = aws_iam_role.ai_bookseller_ec2.name
}

resource "aws_instance" "ai_bookseller" {
  ami                    = data.aws_ami.ubuntu_2204.id
  instance_type          = "t3.large"
  # private-nat tier (unlike the Lambda proxying to it) - needs outbound
  # internet via the existing NAT Gateway to reach ECR/S3/Secrets
  # Manager at boot and on every deploy. See
  # modules/security-groups/main.tf's "AI Tamil Bookseller feature"
  # section for why this differs from the Lambda's own tier placement.
  subnet_id              = module.vpc.private_nat_subnet_ids[0]
  vpc_security_group_ids = [module.security_groups.ec2_ai_bookseller_sg_id]
  iam_instance_profile   = aws_iam_instance_profile.ai_bookseller_ec2.name

  root_block_device {
    volume_size = 40 # OS + Docker image + ~6GB Gemma GGUF + Whisper cache + headroom
    volume_type = "gp3"
    encrypted   = true
  }

  # Deliberately short and Terraform-interpolation-only (every ${...}
  # below is a real Terraform reference) - the actual bootstrap logic
  # lives in ai-service/scripts/ec2-bootstrap.sh, fetched fresh from S3
  # at boot rather than inlined here. Inlining that script's own content
  # via templatefile()/file() would collide: its bash `${VAR:?msg}`
  # parameter-expansion syntax uses the identical `${` marker Terraform's
  # own heredoc interpolation scans for, and Terraform would try (and
  # fail) to resolve `VAR`/`msg` as Terraform identifiers. Keeping the
  # two entirely separate - Terraform renders this short preamble,
  # ec2-bootstrap.sh stays a plain, unmodified, independently-runnable
  # script - sidesteps that class of bug entirely rather than working
  # around it with escaping.
  user_data = <<-EOT
    #!/usr/bin/env bash
    set -euo pipefail
    export AWS_REGION="${data.aws_region.current.name}"
    export MODELS_BUCKET="${aws_s3_bucket.ai_bookseller_models.id}"
    export ECR_REPO_URL="${local.ai_service_ecr_repository_url}"
    export IMAGE_TAG="${var.ai_service_image_tag}"
    export AUTH_TOKEN_SECRET_ARN="${module.secrets_manager.ai_bookseller_internal_token_secret_arn}"
    ASSETS_BUCKET="${aws_s3_bucket.ai_bookseller_assets.id}"

    apt-get update -y
    apt-get install -y unzip curl
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
    unzip -q /tmp/awscliv2.zip -d /tmp
    /tmp/aws/install

    mkdir -p /opt/pk-literature-ai
    aws s3 cp "s3://$ASSETS_BUCKET/docker-compose.yml" /opt/pk-literature-ai/docker-compose.yml --region "$AWS_REGION"
    aws s3 cp "s3://$ASSETS_BUCKET/scripts/ec2-bootstrap.sh" /opt/pk-literature-ai/bootstrap.sh --region "$AWS_REGION"
    chmod +x /opt/pk-literature-ai/bootstrap.sh
    /opt/pk-literature-ai/bootstrap.sh
  EOT

  tags = {
    Name        = "pk-literature-${var.environment}-ai-bookseller"
    Environment = var.environment
  }
}
