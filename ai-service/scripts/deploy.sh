#!/usr/bin/env bash
# Update/redeploy script — run on the EC2 host itself (SSM Session
# Manager, no SSH/public IP needed — see ai-bookseller-ec2.tf's IAM
# instance profile) after a new image has been pushed to ECR. Matches
# spec's exact deploy flow: "pull new image, docker compose up -d".
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
ECR_REPO_URL="${ECR_REPO_URL:?Set ECR_REPO_URL}"

cd /opt/pk-literature-ai

echo "==> Logging into ECR"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REPO_URL"

echo "==> Pulling latest image"
docker pull "${ECR_REPO_URL}:latest"
docker tag "${ECR_REPO_URL}:latest" pk-literature-ai-service:latest

echo "==> Restarting the service"
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
