#!/usr/bin/env bash
# First-boot bootstrap for the AI Bookseller EC2 host — passed as
# user_data by terraform/environments/prod/ai-bookseller-ec2.tf. Runs
# once at instance launch (cloud-init); scripts/deploy.sh is the
# separate script for subsequent updates.
#
# Assumes Ubuntu 22.04 LTS. Everything below is idempotent-ish (safe to
# re-run manually if a step fails partway) except the `apt-get install`
# block, which is naturally idempotent already.
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
MODELS_BUCKET="${MODELS_BUCKET:?Set MODELS_BUCKET (injected by Terraform templatefile())}"
ECR_REPO_URL="${ECR_REPO_URL:?Set ECR_REPO_URL (injected by Terraform templatefile())}"
# ECR tags are IMMUTABLE (terraform/bootstrap/ecr.tf) - same
# never-"latest" convention as medusa_image_tag/directus_image_tag.
# Injected by Terraform from var.ai_service_image_tag.
IMAGE_TAG="${IMAGE_TAG:?Set IMAGE_TAG (injected by Terraform templatefile() from var.ai_service_image_tag)}"
AUTH_TOKEN_SECRET_ARN="${AUTH_TOKEN_SECRET_ARN:?Set AUTH_TOKEN_SECRET_ARN (injected by Terraform templatefile())}"

echo "==> Installing Docker + Compose plugin"
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sh /tmp/get-docker.sh
usermod -aG docker ubuntu

# Spec: "Docker daemon enabled on boot (systemctl enable docker) -
# service survives EC2 reboot without custom systemd units." get-docker.sh
# already enables+starts the daemon, but this is explicit/idempotent on
# a re-run and matches the spec's own wording exactly.
systemctl enable docker
systemctl start docker

echo "==> Installing AWS CLI v2 (for S3/Secrets Manager/ECR calls below)"
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install

echo "==> Creating model + log directories"
mkdir -p /var/lib/pk-literature-ai/models
mkdir -p /opt/pk-literature-ai

echo "==> Downloading model weights from S3 (skipped if already present)"
if [ ! -f /var/lib/pk-literature-ai/models/gemma-2b.gguf ]; then
  aws s3 cp "s3://${MODELS_BUCKET}/gemma-2b.gguf" /var/lib/pk-literature-ai/models/gemma-2b.gguf --region "$AWS_REGION"
fi
# Whisper Tiny (~75MB) is left to openai-whisper's own first-run
# download-and-cache behavior inside the container rather than
# pre-staged here — small enough that re-fetching it on a rare cold
# container start isn't worth a second S3 round trip to manage.

echo "==> Fetching the internal auth token from Secrets Manager"
AUTH_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id "$AUTH_TOKEN_SECRET_ARN" \
  --region "$AWS_REGION" \
  --query SecretString --output text)

echo "==> Logging into ECR"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REPO_URL"

echo "==> Writing .env for docker-compose"
cat > /opt/pk-literature-ai/.env <<EOF
AI_SERVICE_AUTH_TOKEN=${AUTH_TOKEN}
AI_SERVICE_IMAGE=${ECR_REPO_URL}:${IMAGE_TAG}
WHISPER_MODEL=tiny
LORA_PATH=
EOF
chmod 600 /opt/pk-literature-ai/.env

echo "==> Pulling image ${ECR_REPO_URL}:${IMAGE_TAG}"
docker pull "${ECR_REPO_URL}:${IMAGE_TAG}"

# docker-compose.yml + the repo checkout aren't present on a fresh
# instance by user_data alone — copied in by the same Terraform
# provisioner that renders this script (ai-bookseller-ec2.tf's
# file provisioner for ai-service/docker-compose.yml).
cd /opt/pk-literature-ai
docker compose up -d

echo "==> Bootstrap complete"
