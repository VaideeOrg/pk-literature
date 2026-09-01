# AI Tamil Bookseller — ai-service

LLM + ASR host for the AI Tamil Bookseller feature. Runs on a single
EC2 instance (t3.large, CPU-only), fronted by `apps/api-ai-bookseller`
(a Lambda proxy — see that service's own README for the split of
responsibilities between it and this one).

```
apps/api-ai-bookseller (Lambda) --private HTTP--> this service (EC2)
                                                     |- LLM: google/gemma-2-2b-it (llama.cpp, quantized GGUF)
                                                     '- ASR: Whisper Tiny
```

## Why this is a plain EC2 host, not Lambda/ECS/SageMaker

Every other backend in this repo is Lambda or ECS Fargate — this is the
first EC2 instance in the stack. That's deliberate, not a shortcut:
Gemma 2B + Whisper Tiny need to stay resident in memory across requests
(a 10-15s cold model load per request is a non-starter), which rules out
Lambda; and spec explicitly scopes out SageMaker/GPU/ALB/Fargate for
this MVP given the "low-traffic, experimental feature" framing.

## Directory layout

```
ai-service/
  api/server.py       Flask app: /chat, /asr, /health, auth-token check
  llm/provider.py      Abstract LLM interface
  llm/gemma.py          google/gemma-2-2b-it via llama.cpp
  asr/provider.py      Abstract ASR interface
  asr/whisper.py        Whisper Tiny
  persona/system_prompt.txt
  tests/                pytest suite (fake providers, no model weights needed)
  benchmarks/benchmark.py
  Dockerfile
  docker-compose.yml
```

Both provider interfaces are deliberately thin — swapping the LLM
runtime, adding a LoRA persona adapter, or moving ASR to a different
model only ever means a new class against `LLMProvider`/`ASRProvider`,
never touching `api/server.py`.

## Model weights

**Gemma checkpoint**: [`google/gemma-2-2b-it`](https://huggingface.co/google/gemma-2-2b-it)
— Gemma **2** generation (not Gemma 1's `gemma-2b-it`), official
instruction-tuned base model, not a Tamil-finetuned variant. Same
"prompt-only persona" reasoning as before: Tamil fluency and the
bookseller character both come from `persona/system_prompt.txt` alone,
nothing in the weights themselves is Tamil-specific.

Pre-quantized GGUF already exists — no manual conversion needed, unlike
the Gemma 1 path this replaced:

```bash
huggingface-cli download bartowski/gemma-2-2b-it-GGUF \
  gemma-2-2b-it-Q4_K_M.gguf --local-dir .
mv gemma-2-2b-it-Q4_K_M.gguf gemma-2b.gguf
```

That community repo republishes Google's weights already converted and
quantized — it doesn't gate the download behind HF's click-through
license acceptance the way `google/gemma-2-2b-it` itself does, but
Gemma's usage terms still apply regardless of which repo the bytes came
from; worth reading them once before relying on this in production.

**Real, unresolved risk worth flagging**: Gemma 2 has a genuinely
different architecture from Gemma 1 (sliding window attention, logit
soft-capping) - llama.cpp's support for these landed fast after Gemma
2's June 2024 release, but early support for a brand-new architecture
historically had rough edges (soft-capping and sliding-window
correctness both saw fixes trickle in over the following months). The
pinned `llama-cpp-python==0.2.90` release window overlaps that same
period, and nothing here confirms which side of the fixes it landed on.
A broken implementation of either mechanism tends to show up as
repetitive or degrading output at longer context, not a clean load
failure - exactly what the benchmark script's 20 Tamil prompts are for.
Run it for real before trusting this in production; bump
`llama-cpp-python` if the output looks wrong rather than assuming the
model itself is at fault.

Upload the resulting `gemma-2b.gguf` to the models bucket (see Release
sequence in the top-level PR — the `ai_bookseller_models_bucket`
Terraform output names the exact bucket):

```bash
aws s3 cp gemma-2b.gguf s3://<ai_bookseller_models_bucket output>/gemma-2b.gguf
```

`GEMMA_MODEL_PATH` (env var, `llm/gemma.py`) just points at wherever
this file ends up — `/models/gemma-2b.gguf` in the container, bind-mounted
from `/var/lib/pk-literature-ai/models` on the EC2 host
(`scripts/ec2-bootstrap.sh` pulls it from S3 to that path). The filename
itself carries no meaning to the code; it's a fixed convention, not a
lookup key — swapping in a different finetune or a LoRA adapter later
never means touching `gemma.py`, just re-uploading to the same S3 key.

**Whisper checkpoint**: OpenAI's official `tiny` multilingual Whisper
(`WHISPER_MODEL` env var) — auto-downloaded by `openai-whisper` on first
use, no manual conversion or upload needed (see `asr/whisper.py` and the
docker-compose.yml comment on the whisper-cache mount).

## EC2 setup

### Launch

- **Instance**: t3.large (2 vCPU, 8GB RAM), Ubuntu 22.04 LTS AMI
- **Subnet**: private-nat tier (`terraform/environments/prod/ai-bookseller-ec2.tf`)
  — needs outbound internet via the existing NAT Gateway to pull the
  Docker image from ECR and the model weights from S3 at boot/update.
  No public IP, no ALB (spec: "No ALB ... for MVP").
- **Security group**: `ec2_ai_bookseller` (`terraform/modules/security-groups`)
  — ingress 5000 from the `lambda_ai_bookseller` SG only, egress 443 to
  the internet (NAT) for image/model pulls.
- **IAM instance profile**: ECR pull (`ecr:GetAuthorizationToken`,
  `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`), S3 read on the
  models bucket, Secrets Manager read on `/pk-literature/prod/ai-bookseller/internal-token`.

### First-boot bootstrap (`user_data`, see the Terraform file)

Installs Docker + Compose plugin, enables the daemon on boot
(`systemctl enable docker` — spec: "Docker daemon enabled on boot ...
service survives EC2 reboot without custom systemd units"), pulls the
model weights from S3, fetches the auth token from Secrets Manager, and
starts the container. Full script: `scripts/ec2-bootstrap.sh`.

### Deploy / update (`scripts/deploy.sh`)

```bash
./scripts/deploy.sh
```

Pulls the latest image from ECR and runs `docker compose up -d` —
matches spec's stated deploy flow exactly ("Deployment/update script:
pull new image, docker compose up -d").

## Local development

```bash
cd ai-service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Download models manually for local testing (see scripts/ec2-bootstrap.sh
# for the same S3 paths used in prod), or point GEMMA_MODEL_PATH at
# wherever you already have a Gemma 2B GGUF locally.
mkdir -p /tmp/ai-models
export GEMMA_MODEL_PATH=/tmp/ai-models/gemma-2b.gguf
export AI_SERVICE_AUTH_TOKEN=dev-only-placeholder

python api/server.py
```

## Tests

```bash
cd ai-service
pip install flask python-dotenv pytest numpy
python -m pytest tests/
```

Runs against fake LLM/ASR providers (`tests/conftest.py` stubs the
native `llama_cpp`/`whisper`/`soundfile`/`librosa` imports) — no model
weights or GPU/heavy native wheels needed. Verified passing (8/8) in
this repo's own sandbox before committing.

## Benchmarks

```bash
python benchmarks/benchmark.py --audio-dir /path/to/wav/samples
```

Needs the real model weights loaded — not meant for CI. Measures model
startup time, RAM, per-prompt/per-sample latency, and approximate
tokens/sec across 20 built-in Tamil text prompts; the ASR half needs a
local directory of `.wav` samples (none ship with this repo — see the
script's own header for why). CPU usage and true time-to-first-token
are NOT measured by this script; see its header comment for why each
was left out rather than half-implemented.

## API

See `packages/contracts/src/ai-bookseller-api.ts` for the full
request/response shapes as consumed by `apps/api-ai-bookseller`. This
service's own contract (what it exposes to that Lambda, not to the
frontend) is simpler — snake_case, no circuit-breaker/feature-flag
concerns (those live entirely in the Lambda):

- `POST /chat` — `{message, book, conversation_id, history}` -> `{response, conversation_id}`
- `POST /asr` — multipart, field `audio` -> `{text}`
- `GET /health` — `{status, llm, asr}` (no auth required)

Every request to `/chat`/`/asr` requires `Authorization: Bearer
<AI_SERVICE_AUTH_TOKEN>` — the internal Lambda<->EC2 shared secret
(Secrets Manager: `/pk-literature/prod/ai-bookseller/internal-token`).

## Non-goals for MVP

RAG/pgvector/semantic search, SageMaker, ALB, GPU, multiple model
instances, server-side TTS (browser Web Speech API instead), multiple
personas, LoRA training (tracked separately — `LORA_PATH` is wired but
unused), conversation persistence beyond one browser session,
authenticated identity for this feature.
