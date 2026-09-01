"""
Stubs the heavy native ML dependencies (llama-cpp-python, openai-whisper,
soundfile, librosa) so this test suite can run without installing
multi-GB CPU/GPU wheels or downloading model weights — every test
replaces GemmaProvider/WhisperProvider's *instances* (see test_server.py's
client fixture), so these stand-ins only need to exist long enough for
`from llm.gemma import GemmaProvider` / `from asr.whisper import
WhisperProvider` to succeed at import time.
"""

import sys
import types


def _stub_module(name: str) -> types.ModuleType:
    if name in sys.modules:
        return sys.modules[name]
    module = types.ModuleType(name)
    sys.modules[name] = module
    return module


llama_cpp = _stub_module("llama_cpp")
llama_cpp.Llama = type("Llama", (), {"__init__": lambda self, **kwargs: None, "__call__": lambda self, *a, **k: {}})

whisper_stub = _stub_module("whisper")
whisper_stub.load_model = lambda size: object()
whisper_stub.load_audio = lambda path: None
whisper_stub.pad_or_trim = lambda audio: audio

soundfile_stub = _stub_module("soundfile")
soundfile_stub.read = lambda *a, **k: (None, 16000)

librosa_stub = _stub_module("librosa")
librosa_stub.resample = lambda *a, **k: None
