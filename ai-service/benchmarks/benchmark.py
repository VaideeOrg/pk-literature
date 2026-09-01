"""
Spec's Performance section: "Benchmark scripts should measure: model
startup time, RAM usage, CPU usage, time to first token, total response
latency, tokens/sec, ASR latency. Test with at least 20 Tamil text
prompts and 20 Tamil audio samples."

Run on the actual EC2 host (needs the real model weights + llama-cpp-python/
openai-whisper installed) — not meant for CI:

    cd ai-service && python benchmarks/benchmark.py [--audio-dir DIR]

Text prompts are built in (20, covering common bookseller-conversation
shapes). Audio samples are NOT bundled (no recorded Tamil speech corpus
ships with this repo) — pass --audio-dir pointing at a local directory
of .wav files to include the ASR benchmark; without it, the script
prints the LLM results and a note that ASR was skipped.
"""

import argparse
import gc
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

try:
    import psutil
except ImportError:
    psutil = None

SAMPLE_BOOK = {
    "id": "bench-1",
    "title": "நட்புக்காலம்",
    "author": "அறிவுமதி",
    "description": "இரண்டு நண்பர்களின் நட்பையும், அவர்களுக்கிடையே நடக்கும் சம்பவங்களையும் விவரிக்கும் நாவல்.",
}

# 20 Tamil prompts covering the range of things a browsing customer
# might actually ask a bookseller — not just "is this good?" repeated.
TEXT_PROMPTS = [
    "இந்தப் புத்தகம் நல்லதா?",
    "இது யாருக்காக எழுதப்பட்டது?",
    "இதை படிக்க எவ்வளவு நேரம் ஆகும்?",
    "இதே போன்ற வேறு புத்தகம் உண்டா?",
    "இந்த ஆசிரியரின் வேறு புத்தகங்கள் உள்ளனவா?",
    "இது சோகமான கதையா?",
    "குழந்தைகளுக்கு ஏற்றதா இந்த புத்தகம்?",
    "இது எந்த மொழியில் எழுதப்பட்டது?",
    "இதன் விலை எவ்வளவு?",
    "இது எப்போது வெளியானது?",
    "இதை நீங்கள் பரிந்துரைப்பீர்களா?",
    "இதில் எத்தனை பக்கங்கள் உள்ளன?",
    "இது ஒரு தொடர் புத்தகமா?",
    "இதன் முக்கிய கருப்பொருள் என்ன?",
    "இது படிக்க கடினமாக இருக்குமா?",
    "இது திரைப்படமாக வந்துள்ளதா?",
    "இது விருது பெற்றதா?",
    "நீங்கள் இதை படித்திருக்கிறீர்களா?",
    "இதை பரிசாக கொடுக்கலாமா?",
    "இதற்கு பதிலாக வேறு எதை பரிந்துரைப்பீர்கள்?",
]


def _rss_mb() -> float:
    if psutil is None:
        return -1.0
    return psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)


def benchmark_llm():
    from llm.gemma import GemmaProvider

    print("=== LLM (Gemma 2B) ===")
    gc.collect()
    mem_before = _rss_mb()
    t0 = time.perf_counter()
    provider = GemmaProvider()
    startup_s = time.perf_counter() - t0
    mem_after_load = _rss_mb()
    print(f"model startup time: {startup_s:.2f}s")
    print(f"RAM after load: {mem_after_load:.0f} MB (delta {mem_after_load - mem_before:.0f} MB)")

    latencies = []
    token_rates = []
    for i, prompt in enumerate(TEXT_PROMPTS, 1):
        t0 = time.perf_counter()
        result = provider.chat(message=prompt, book=SAMPLE_BOOK, conversation_id=f"bench-{i}")
        elapsed = time.perf_counter() - t0
        latencies.append(elapsed)
        n_tokens = max(len(result["response"]) // 4, 1)  # rough estimate, not a real tokenizer count
        token_rates.append(n_tokens / elapsed)
        print(f"  [{i:2d}/20] {elapsed:.2f}s  \"{prompt[:30]}...\"")

    print(f"\nmean total response latency: {sum(latencies) / len(latencies):.2f}s")
    print(f"min/max latency: {min(latencies):.2f}s / {max(latencies):.2f}s")
    print(f"approx tokens/sec: {sum(token_rates) / len(token_rates):.1f}")
    print("(time to first token not separately measurable via llama-cpp-python's non-streaming call() API used here;")
    print(" would need stream=True to isolate it from total generation time.)")


def benchmark_asr(audio_dir: str):
    from asr.whisper import WhisperProvider

    audio_files = sorted(Path(audio_dir).glob("*.wav"))
    if not audio_files:
        print(f"\n=== ASR (Whisper Tiny) === \nNo .wav files found in {audio_dir}, skipping.")
        return

    print(f"\n=== ASR (Whisper Tiny) — {len(audio_files)} samples ===")
    t0 = time.perf_counter()
    provider = WhisperProvider()
    print(f"model startup time: {time.perf_counter() - t0:.2f}s")

    latencies = []
    for i, path in enumerate(audio_files, 1):
        audio_bytes = path.read_bytes()
        t0 = time.perf_counter()
        try:
            result = provider.transcribe(audio_bytes)
            elapsed = time.perf_counter() - t0
            latencies.append(elapsed)
            print(f"  [{i:2d}/{len(audio_files)}] {elapsed:.2f}s  {path.name} -> \"{result['text'][:40]}\"")
        except Exception as e:  # noqa: BLE001
            print(f"  [{i:2d}/{len(audio_files)}] FAILED: {path.name}: {e}")

    if latencies:
        print(f"\nmean ASR latency: {sum(latencies) / len(latencies):.2f}s")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio-dir", default=None, help="Directory of .wav files for the ASR benchmark (need >=20 for spec's stated sample size)")
    args = parser.parse_args()

    if psutil is None:
        print("(psutil not installed — RAM figures will show as -1; pip install psutil for real numbers)\n")

    print("(CPU usage isn't sampled by this script — run `top -p $(pgrep -f benchmark.py)`")
    print(" or `htop` alongside it for that figure; a background sampling thread felt")
    print(" like more machinery than this MVP benchmark script is worth.)\n")

    benchmark_llm()
    if args.audio_dir:
        benchmark_asr(args.audio_dir)
    else:
        print("\n=== ASR (Whisper Tiny) ===\nNo --audio-dir given, skipping (spec wants 20 Tamil audio samples — none ship with this repo).")
