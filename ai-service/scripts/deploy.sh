#!/usr/bin/env bash
# Update/redeploy script — run on the EC2 host itself (SSM Session
# Manager, no SSH/public IP needed — see ai-bookseller-ec2.tf's IAM
# instance profile) after a new image has been pushed to ECR under a
# NEW tag (repo is IMMUTABLE - re-pushing an existing tag fails, and
# there is no "latest" to float). Matches spec's exact deploy flow:
# "pull new image, docker compose up -d" - the "new image" here means
# "a new tag", same as bumping medusa_image_tag/directus_image_tag.
#
# Usage: IMAGE_TAG=1.2.0 ./deploy.sh
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
ECR_REPO_URL="${ECR_REPO_URL:?Set ECR_REPO_URL}"
IMAGE_TAG="${IMAGE_TAG:?Set IMAGE_TAG to the tag pushed by build-ai-service-image.yml}"

cd /opt/pk-literature-ai

echo "==> Logging into ECR"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REPO_URL"

echo "==> Pulling ${ECR_REPO_URL}:${IMAGE_TAG}"
docker pull "${ECR_REPO_URL}:${IMAGE_TAG}"

echo "==> Updating .env and restarting the service"
sed -i "s|^AI_SERVICE_IMAGE=.*|AI_SERVICE_IMAGE=${ECR_REPO_URL}:${IMAGE_TAG}|" .env
docker compose up -d

echo "==> Waiting for health check"
for i in $(seq 1 30); do
  if curl -sf http://localhost:5000/health > /dev/null; then
    echo "Healthy."
    exit 0
  fi
  sleep 2
done

echo "Service did not become healthy within 60s - check 'docker compose logs'" >&2
exit 1
