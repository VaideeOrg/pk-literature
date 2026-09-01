"""
LLM Provider Interface — kept replaceable per spec's "Keep LLM and ASR
implementations replaceable." Swapping the base model, adding LoRA, or
moving to a different inference runtime should only ever mean writing a
new class against this interface, never touching api/server.py.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional


class LLMProvider(ABC):
    """Abstract base class for LLM implementations."""

    @abstractmethod
    def chat(
        self,
        message: str,
        book: Dict[str, Any],
        conversation_id: str,
        history: Optional[List[Dict[str, str]]] = None,
    ) -> Dict[str, Any]:
        """
        Generate a response from the LLM.

        Returns: {"response": str, "conversation_id": str}
        Raises on failure — api/server.py is responsible for catching
        and translating into the spec's fallback shape; this layer
        stays a plain provider, not a fallback-aware one.
        """
        raise NotImplementedError

    @abstractmethod
    def health(self) -> Dict[str, str]:
        """Returns: {"status": "ok" | "error", "model": str}"""
        raise NotImplementedError
