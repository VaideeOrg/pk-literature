"""
AI Service API — Flask server fronting the LLM + ASR providers.
Handles /chat, /asr, /health. Private-network only: not directly
internet-reachable (see terraform's ec2 security group — ingress
restricted to the api-ai-bookseller Lambda's security group), but still
requires AI_SERVICE_AUTH_TOKEN on every request as defense in depth,
matching spec's "internal Lambda<->EC2 auth token via Secrets Manager".
"""

import json
import logging
import os
from functools import wraps

from dotenv import load_dotenv
from flask import Flask, jsonify, request

from asr.whisper import WhisperProvider
from llm.gemma import GemmaProvider

load_dotenv()

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Spec: "server-side hard limit: a few MB". Flask rejects anything
# larger before it ever reaches request.files, returning a 413.
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024

AUTH_TOKEN = os.environ.get("AI_SERVICE_AUTH_TOKEN")

# Providers are constructed once at process start (not per-request) —
# loading the GGUF weights and the Whisper model on every call would
# make every response pay the ~10-15s model-load cost spec's own
# benchmark section calls out as "model startup time", separate from
# per-request inference latency.
_llm = None
_asr = None
_init_error = None

try:
    _llm = GemmaProvider()
    _asr = WhisperProvider()
except Exception as e:  # noqa: BLE001 - genuinely want to catch anything at boot
    logger.error("Failed to initialize providers: %s", e)
    _init_error = str(e)


def require_auth_token(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not AUTH_TOKEN:
            # Misconfiguration, not a client error — fail loudly rather
            # than silently accepting unauthenticated requests.
            logger.error("AI_SERVICE_AUTH_TOKEN is not set")
            return jsonify({"error": "Service misconfigured"}), 500

        header = request.headers.get("Authorization", "")
        if header != f"Bearer {AUTH_TOKEN}":
            return jsonify({"error": "Unauthorized"}), 401

        return fn(*args, **kwargs)

    return wrapper


@app.get("/health")
def health():
    """No auth required — used for container/orchestration health checks."""
    if _init_error:
        return jsonify({"status": "error", "error": _init_error}), 503

    llm_health = _llm.health()
    asr_health = _asr.health()
    ok = llm_health["status"] == "ok" and asr_health["status"] == "ok"

    return jsonify({
        "status": "ok" if ok else "degraded",
        "llm": llm_health,
        "asr": asr_health,
    })


@app.post("/chat")
@require_auth_token
def chat():
    if _init_error:
        return jsonify({"error": "Service unavailable"}), 503

    data = request.get_json(silent=True) or {}
    message = data.get("message")
    book = data.get("book") or {}
    conversation_id = data.get("conversation_id", "unknown")
    history = data.get("history") or []

    if not message or not isinstance(message, str):
        return jsonify({"error": 'Missing or invalid "message"'}), 400

    try:
        result = _llm.chat(message=message, book=book, conversation_id=conversation_id, history=history)
        logger.info(json.dumps({
            "event": "chat",
            "conversation_id": conversation_id,
            "book_id": book.get("id"),
            "success": True,
        }))
        return jsonify(result)
    except Exception as e:  # noqa: BLE001 - translate any provider failure into a 502
        logger.warning("chat failed for conversation %s: %s", conversation_id, e)
        logger.info(json.dumps({
            "event": "chat",
            "conversation_id": conversation_id,
            "book_id": book.get("id"),
            "success": False,
        }))
        # 502, not the spec's fallback JSON shape — that shape is
        # api-ai-bookseller's responsibility to construct (it owns the
        # circuit breaker and the exact fallback copy); this service
        # only needs to signal "the call failed" clearly.
        return jsonify({"error": "LLM inference failed"}), 502


@app.post("/asr")
@require_auth_token
def asr():
    if _init_error:
        return jsonify({"error": "Service unavailable"}), 503

    if "audio" not in request.files:
        return jsonify({"error": 'Missing "audio" file field'}), 400

    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()

    if not audio_bytes:
        return jsonify({"error": "Empty audio file"}), 400

    try:
        result = _asr.transcribe(audio_bytes)
        return jsonify(result)
    except Exception as e:  # noqa: BLE001
        # Spec: "Never send failed/empty ASR output to the LLM" — this
        # response's 502 status plus omitted "text" key is what lets
        # api-ai-bookseller's caller distinguish this from a real
        # transcription and refuse to forward it to /chat.
        logger.warning("asr failed: %s", e)
        return jsonify({"error": "ASR failed"}), 502


@app.errorhandler(413)
def request_too_large(_e):
    return jsonify({"error": "Audio exceeds size limit"}), 413


@app.errorhandler(404)
def not_found(_e):
    return jsonify({"error": "Not found"}), 404


@app.errorhandler(500)
def internal_error(e):
    logger.error("Internal error: %s", e)
    return jsonify({"error": "Internal server error"}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
