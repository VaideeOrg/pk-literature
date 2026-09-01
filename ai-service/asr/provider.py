"""
ASR Provider Interface — same replaceable-implementation pattern as
llm/provider.py.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict


class ASRProvider(ABC):
    """Abstract base class for ASR implementations."""

    @abstractmethod
    def transcribe(self, audio_bytes: bytes) -> Dict[str, Any]:
        """
        Transcribe Tamil audio to text.

        Returns: {"text": str}
        Raises on failure or empty transcription — api/server.py
        translates into the spec's {"text": null, "fallback": true,
        "error_code": "ASR_UNAVAILABLE"} shape.
        """
        raise NotImplementedError

    @abstractmethod
    def health(self) -> Dict[str, str]:
        """Returns: {"status": "ok" | "error", "model": str}"""
        raise NotImplementedError
