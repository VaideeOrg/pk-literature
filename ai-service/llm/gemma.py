"""
Tamil Gemma 2B LLM via llama.cpp — prompt-only persona (no LoRA at MVP,
LORA_PATH stays optional per spec, wired but unused).
"""

import os
import time
from typing import Any, Dict, List, Optional

from llama_cpp import Llama

from .provider import LLMProvider

_PERSONA_PATH = os.path.join(os.path.dirname(__file__), "..", "persona", "system_prompt.txt")


class GemmaProvider(LLMProvider):
    def __init__(self) -> None:
        self.model_path = os.environ["GEMMA_MODEL_PATH"]
        # Tracked as a separate project per spec — read but unused until
        # a LoRA adapter actually exists; llama-cpp-python's lora_path
        # kwarg is a no-op when None.
        self.lora_path = os.environ.get("LORA_PATH") or None
        self.max_tokens = int(os.environ.get("GEMMA_MAX_TOKENS", "256"))
        self.system_prompt = self._load_system_prompt()

        self.llm = Llama(
            model_path=self.model_path,
            lora_path=self.lora_path,
            n_ctx=2048,
            n_threads=int(os.environ.get("GEMMA_N_THREADS", "2")),
            n_gpu_layers=0,  # CPU-only for MVP (spec: "No ... GPU for MVP")
            verbose=False,
        )

    def _load_system_prompt(self) -> str:
        with open(_PERSONA_PATH, "r", encoding="utf-8") as f:
            return f.read().strip()

    def _format_history(self, history: Optional[List[Dict[str, str]]]) -> str:
        if not history:
            return "(உரையாடல் இதுவரை இல்லை)"
        lines = []
        for turn in history[-8:]:  # spec: frontend holds/resends last 6-8 turns
            speaker = "வாடிக்கையாளர்" if turn.get("role") == "user" else "கடைக்காரர்"
            lines.append(f"{speaker}: {turn.get('content', '')}")
        return "\n".join(lines)

    def _build_prompt(self, message: str, book: Dict[str, Any], history: Optional[List[Dict[str, str]]]) -> str:
        return f"""{self.system_prompt}

இந்த புத்தகம்:
தலைப்பு: {book.get('title') or 'தெரியவில்லை'}
ஆசிரியர்: {book.get('author') or 'தெரியவில்லை'}
விளக்கம்: {book.get('description') or 'கொடுக்கப்படவில்லை'}

உரையாடல் வரலாறு:
{self._format_history(history)}

வாடிக்கையாளர்: {message}
கடைக்காரர்:"""

    def chat(
        self,
        message: str,
        book: Dict[str, Any],
        conversation_id: str,
        history: Optional[List[Dict[str, str]]] = None,
    ) -> Dict[str, Any]:
        prompt = self._build_prompt(message, book, history)

        result = self.llm(
            prompt,
            max_tokens=self.max_tokens,
            temperature=0.7,
            top_p=0.9,
            stop=["\nவாடிக்கையாளர்:", "\nஇந்த புத்தகம்:"],
        )

        text = result["choices"][0]["text"].strip()
        if not text:
            raise RuntimeError("Gemma returned an empty completion")

        return {"response": text, "conversation_id": conversation_id}

    def health(self) -> Dict[str, str]:
        # No synthetic inference call here — running a real generation
        # on every /health hit (which CloudFront/API-Gateway-style
        # health checks can call frequently) would burn CPU on a
        # single-core-constrained t3.large for no real signal beyond
        # "the model file loaded", which __init__ already establishes
        # by not raising.
        return {"status": "ok", "model": f"gemma-2b ({os.path.basename(self.model_path)})"}
