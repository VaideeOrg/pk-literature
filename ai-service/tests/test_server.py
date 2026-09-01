"""
Endpoint-level tests against api/server.py using fake LLM/ASR providers
— never load the real ~5-6GB Gemma GGUF or Whisper Tiny in CI/local
test runs. Run with: cd ai-service && pytest
"""

import io
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

# api.server constructs real GemmaProvider()/WhisperProvider() instances
# at import time, which fails without the actual model files present
# (setting its module-level _init_error) — expected and harmless here,
# since every test below replaces _llm/_asr/_init_error directly rather
# than relying on that import-time construction succeeding.
import api.server as server_module  # noqa: E402


@pytest.fixture
def client(monkeypatch):
    # AUTH_TOKEN is read once at module-import time in server.py, so
    # setenv alone wouldn't affect the already-bound global — patch it
    # directly instead.
    monkeypatch.setattr(server_module, "AUTH_TOKEN", "test-token")

    fake_llm = MagicMock()
    fake_llm.chat.return_value = {"response": "வணக்கம்!", "conversation_id": "conv-1"}
    fake_llm.health.return_value = {"status": "ok", "model": "gemma-2b (fake)"}

    fake_asr = MagicMock()
    fake_asr.transcribe.return_value = {"text": "வணக்கம்"}
    fake_asr.health.return_value = {"status": "ok", "model": "whisper-tiny (fake)"}

    monkeypatch.setattr(server_module, "_llm", fake_llm)
    monkeypatch.setattr(server_module, "_asr", fake_asr)
    monkeypatch.setattr(server_module, "_init_error", None)
    server_module.app.config["TESTING"] = True

    yield server_module.app.test_client(), fake_llm, fake_asr


AUTH_HEADERS = {"Authorization": "Bearer test-token"}


def test_health_no_auth_required(client):
    test_client, _, _ = client
    resp = test_client.get("/health")
    assert resp.status_code == 200
    assert resp.get_json()["status"] == "ok"


def test_chat_requires_auth(client):
    test_client, _, _ = client
    resp = test_client.post("/chat", json={"message": "hi", "book": {}, "conversation_id": "c1"})
    assert resp.status_code == 401


def test_chat_success(client):
    test_client, fake_llm, _ = client
    resp = test_client.post(
        "/chat",
        json={"message": "இது நல்ல புத்தகமா?", "book": {"title": "X"}, "conversation_id": "c1"},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["response"] == "வணக்கம்!"
    fake_llm.chat.assert_called_once()


def test_chat_missing_message(client):
    test_client, _, _ = client
    resp = test_client.post("/chat", json={"book": {}, "conversation_id": "c1"}, headers=AUTH_HEADERS)
    assert resp.status_code == 400


def test_chat_llm_failure_returns_502(client):
    test_client, fake_llm, _ = client
    fake_llm.chat.side_effect = RuntimeError("model crashed")
    resp = test_client.post(
        "/chat",
        json={"message": "hi", "book": {}, "conversation_id": "c1"},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 502


def test_asr_success(client):
    test_client, _, fake_asr = client
    resp = test_client.post(
        "/asr",
        data={"audio": (io.BytesIO(b"fake-wav-bytes"), "recording.wav")},
        headers=AUTH_HEADERS,
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200
    assert resp.get_json()["text"] == "வணக்கம்"
    fake_asr.transcribe.assert_called_once()


def test_asr_missing_file(client):
    test_client, _, _ = client
    resp = test_client.post("/asr", headers=AUTH_HEADERS)
    assert resp.status_code == 400


def test_asr_failure_returns_502(client):
    test_client, _, fake_asr = client
    fake_asr.transcribe.side_effect = RuntimeError("empty transcription")
    resp = test_client.post(
        "/asr",
        data={"audio": (io.BytesIO(b"fake-wav-bytes"), "recording.wav")},
        headers=AUTH_HEADERS,
        content_type="multipart/form-data",
    )
    assert resp.status_code == 502
