FROM python:3.11-slim

# ffmpeg: whisper's load_audio fallback path (asr/whisper.py) shells out
# to it for container formats soundfile can't parse directly (webm/opus
# from browser MediaRecorder). libsndfile1: soundfile's native dependency.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    build-essential \
    cmake \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY api/ ./api/
COPY llm/ ./llm/
COPY asr/ ./asr/
COPY persona/ ./persona/

# Model weights are NOT baked into the image (spec's own deploy flow —
# "pull new image, docker compose up -d" — assumes a fast, small image
# pull; Gemma's GGUF alone is ~5-6GB). They live on the host at /models,
# bind-mounted read-only below, populated once by the EC2 setup script
# (terraform/environments/prod/ai-bookseller-ec2.tf's user_data) rather
# than re-downloaded on every image update.
RUN mkdir -p /models

ENV PORT=5000 \
    GEMMA_MODEL_PATH=/models/gemma-2b.gguf \
    WHISPER_MODEL=tiny \
    LORA_PATH=

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -sf http://localhost:5000/health || exit 1

EXPOSE 5000

# Single worker: llama-cpp-python holds the model in this process's own
# memory, so multiple gunicorn workers would each load a separate copy
# — not viable on an 8GB t3.large alongside Whisper. Concurrency within
# the one worker is limited (spec's own framing: "low-traffic,
# experimental feature"), which is an accepted tradeoff, not an oversight.
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "2", "--timeout", "60", "api.server:app"]
