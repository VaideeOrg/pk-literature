"""
Tamil Whisper Tiny ASR — CPU-only.
"""

import io
import os
from typing import Any, Dict

import numpy as np
import soundfile as sf
import whisper

from .provider import ASRProvider


class WhisperProvider(ASRProvider):
    def __init__(self) -> None:
        self.model_size = os.environ.get("WHISPER_MODEL", "tiny")
        self.model = whisper.load_model(self.model_size)

    def _load_audio(self, audio_bytes: bytes) -> np.ndarray:
        # soundfile handles WAV/FLAC/OGG natively; browser MediaRecorder
        # output (webm/opus) needs ffmpeg on PATH, which whisper's own
        # load_audio (via a temp file) shells out to — used as a
        # fallback when soundfile can't parse the container directly.
        try:
            data, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32")
            if data.ndim > 1:
                data = data.mean(axis=1)  # downmix to mono
            if sample_rate != 16000:
                # whisper expects 16kHz mono — resampling belongs at the
                # edge (client already records at a fixed rate in
                # practice), but a cheap fallback here avoids a hard
                # failure on a slightly-off input.
                import librosa  # local import: only needed on this rarely-hit path

                data = librosa.resample(data, orig_sr=sample_rate, target_sr=16000)
            return data
        except Exception:
            import tempfile

            with tempfile.NamedTemporaryFile(suffix=".audio") as tmp:
                tmp.write(audio_bytes)
                tmp.flush()
                return whisper.load_audio(tmp.name)

    def transcribe(self, audio_bytes: bytes) -> Dict[str, Any]:
        audio = self._load_audio(audio_bytes)
        audio = whisper.pad_or_trim(audio)

        result = self.model.transcribe(audio, language="ta", fp16=False)
        text = (result.get("text") or "").strip()

        if not text:
            raise RuntimeError("Whisper returned an empty transcription")

        return {"text": text}

    def health(self) -> Dict[str, str]:
        return {"status": "ok", "model": f"whisper-{self.model_size}"}
