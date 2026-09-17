#!/usr/bin/env python3
"""
CS2 Chat Translator — voice worker
==================================
WASAPI loopback via PyAudioWPatch CALLBACK mode (blocking read() hangs on silence),
faster-whisper → JSON lines on stdout for the Node parent.
"""

from __future__ import annotations

import argparse
import json
import queue
import struct
import sys
import threading
import time
from collections import deque
from pathlib import Path

import numpy as np


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def list_devices() -> None:
    import pyaudiowpatch as pyaudio

    p = pyaudio.PyAudio()
    try:
        emit({"type": "status", "message": "WASAPI loopback devices:"})
        for loopback in p.get_loopback_device_info_generator():
            emit(
                {
                    "type": "device",
                    "index": int(loopback["index"]),
                    "name": str(loopback["name"]),
                    "rate": int(loopback.get("defaultSampleRate", 0)),
                    "inputs": int(loopback.get("maxInputChannels", 0)),
                    "isLoopback": True,
                }
            )
    finally:
        p.terminate()


def probe_loopback_rms(p, device: dict, seconds: float = 1.2) -> float:
    """Measure average RMS on a loopback device using callback (non-blocking)."""
    import pyaudiowpatch as pyaudio

    rate = int(device["defaultSampleRate"])
    channels = int(device["maxInputChannels"]) or 2
    idx = int(device["index"])
    q: queue.Queue = queue.Queue()
    samples = []

    def callback(in_data, frame_count, time_info, status):  # noqa: ARG001
        q.put(in_data)
        return (in_data, pyaudio.paContinue)

    try:
        stream = p.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=idx,
            frames_per_buffer=512,
            stream_callback=callback,
        )
        stream.start_stream()
        t0 = time.time()
        while time.time() - t0 < seconds:
            try:
                data = q.get(timeout=0.2)
                samples.append(pcm16_rms(data))
            except queue.Empty:
                continue
        stream.stop_stream()
        stream.close()
    except Exception:
        return 0.0

    if not samples:
        return 0.0
    return float(sum(samples) / len(samples))


def pick_loopback_device(p, preferred: str | None = None):
    preferred_l = (preferred or "").lower().strip()
    loopbacks = list(p.get_loopback_device_info_generator())
    if not loopbacks:
        raise RuntimeError("No WASAPI loopback device found. Run with --list-devices.")

    if preferred_l and preferred_l not in ("auto", "default", "*"):
        for info in loopbacks:
            if preferred_l in str(info.get("name", "")).lower():
                return info

    # Auto: pick the loopback that currently has the most audio (CS2 output).
    emit({"type": "status", "message": "Probing loopback devices for active audio…"})
    ranked = []
    for info in loopbacks:
        rms = probe_loopback_rms(p, info, seconds=0.9)
        ranked.append((rms, info))
        emit(
            {
                "type": "status",
                "message": f"  probe rms={rms:.0f} · {info.get('name')}",
            }
        )
    ranked.sort(key=lambda x: x[0], reverse=True)
    if ranked and ranked[0][0] >= 8:
        return ranked[0][1]

    # Fallback: default Windows output's loopback
    try:
        import pyaudiowpatch as pyaudio

        wasapi_info = p.get_host_api_info_by_type(pyaudio.paWASAPI)
        default_out = p.get_device_info_by_index(wasapi_info["defaultOutputDevice"])
        out_name = str(default_out.get("name", ""))
        for info in loopbacks:
            if out_name and out_name in str(info.get("name", "")):
                return info
    except Exception:
        pass

    try:
        default = p.get_default_wasapi_loopback()
        if default:
            return default
    except Exception:
        pass

    return loopbacks[0]


def pcm16_rms(pcm: bytes) -> float:
    if len(pcm) < 4:
        return 0.0
    arr = np.frombuffer(pcm, dtype=np.int16)
    if arr.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(arr.astype(np.float64) ** 2)))


def to_mono_float32(pcm: bytes, channels: int, rate: int) -> np.ndarray:
    """Return mono float32 audio at 16 kHz for Whisper."""
    arr = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        arr = arr.reshape(-1, channels).mean(axis=1)
    if rate != 16000 and arr.size > 0:
        # Linear resample (good enough for speech)
        duration = arr.size / float(rate)
        new_len = max(1, int(duration * 16000))
        x_old = np.linspace(0.0, 1.0, num=arr.size, endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=new_len, endpoint=False)
        arr = np.interp(x_new, x_old, arr).astype(np.float32)
    return arr


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="tiny", choices=["tiny", "base", "small", "medium"])
    parser.add_argument("--chunk", type=float, default=2.8, help="Seconds per transcription window")
    parser.add_argument("--energy", type=float, default=40.0, help="Min RMS (int16 scale) to run Whisper")
    parser.add_argument("--device", default="", help="Substring match for loopback device name")
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--language", default="", help="Force Whisper language (empty = auto)")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    if args.list_devices:
        try:
            import pyaudiowpatch as pyaudio  # noqa: F401
        except ImportError as e:
            emit({"type": "error", "message": f"PyAudioWPatch missing: {e}"})
            return 1
        list_devices()
        return 0

    try:
        import pyaudiowpatch as pyaudio
        from faster_whisper import WhisperModel
    except ImportError as e:
        emit({"type": "error", "message": f"Missing dependency: {e}"})
        return 1

    emit({"type": "status", "message": f"Loading Whisper model '{args.model}' (first run downloads)…"})
    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    p = pyaudio.PyAudio()
    q: queue.Queue = queue.Queue(maxsize=200)
    stop_flag = threading.Event()

    try:
        device = pick_loopback_device(p, args.device or None)
        rate = int(device["defaultSampleRate"])
        channels = int(device["maxInputChannels"])
        if channels < 1:
            channels = 2
        idx = int(device["index"])
        name = str(device["name"])
        chunk_size = 512
        bytes_per_sec = rate * channels * 2
        target_bytes = int(args.chunk * bytes_per_sec)

        def callback(in_data, frame_count, time_info, status):  # noqa: ARG001
            # MUST use callback — blocking stream.read() hangs on WASAPI silence
            try:
                q.put_nowait(in_data)
            except queue.Full:
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(in_data)
                except queue.Full:
                    pass
            return (in_data, pyaudio.paContinue)

        stream = p.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=idx,
            frames_per_buffer=chunk_size,
            stream_callback=callback,
        )
        stream.start_stream()

        emit(
            {
                "type": "ready",
                "device": name,
                "index": idx,
                "rate": rate,
                "channels": channels,
                "model": args.model,
                "chunk": args.chunk,
                "energy": args.energy,
                "mode": "callback",
            }
        )

        buf = bytearray()
        last_text = ""
        last_heartbeat = time.time()
        chunks_seen = 0
        chunks_whispered = 0

        while not stop_flag.is_set():
            try:
                data = q.get(timeout=0.5)
            except queue.Empty:
                # Heartbeat so Node knows we're alive even in silence
                if time.time() - last_heartbeat > 8:
                    emit(
                        {
                            "type": "status",
                            "message": f"listening… (queue empty / silence) device={name}",
                        }
                    )
                    last_heartbeat = time.time()
                continue

            buf.extend(data)
            if len(buf) < target_bytes:
                continue

            pcm = bytes(buf[:target_bytes])
            # keep small overlap so words aren't cut mid-chunk
            overlap = min(len(buf) - target_bytes, int(0.35 * bytes_per_sec))
            del buf[: target_bytes - max(0, overlap)]

            chunks_seen += 1
            energy = pcm16_rms(pcm)

            if time.time() - last_heartbeat > 6:
                emit(
                    {
                        "type": "status",
                        "message": (
                            f"audio ok · rms={energy:.0f} · "
                            f"chunks={chunks_seen} whispered={chunks_whispered}"
                        ),
                    }
                )
                last_heartbeat = time.time()

            if energy < args.energy:
                if args.debug:
                    emit({"type": "status", "message": f"skip quiet chunk rms={energy:.0f}"})
                continue

            audio = to_mono_float32(pcm, channels, rate)
            if audio.size < 1600:  # <0.1s
                continue

            t0 = time.time()
            try:
                segments, info = model.transcribe(
                    audio,
                    language=args.language or None,
                    vad_filter=True,
                    vad_parameters=dict(
                        min_silence_duration_ms=250,
                        speech_pad_ms=200,
                    ),
                    beam_size=1,
                    best_of=1,
                    condition_on_previous_text=False,
                    no_speech_threshold=0.6,
                )
                text = " ".join(s.text.strip() for s in segments).strip()
                lang = getattr(info, "language", None) or args.language or "unknown"
            except Exception as e:
                emit({"type": "error", "message": f"Whisper failed: {e}"})
                continue

            ms = int((time.time() - t0) * 1000)
            chunks_whispered += 1

            if not text or len(text) < 2:
                if args.debug:
                    emit({"type": "status", "message": f"whisper empty ({ms}ms) rms={energy:.0f}"})
                continue

            low = text.lower().strip(" .!?")
            if low in {
                "thanks for watching",
                "thank you",
                "subscribe",
                "music",
                "you",
                ".",
                "..",
                "um",
                "uh",
            }:
                continue
            if text == last_text:
                continue
            last_text = text

            emit(
                {
                    "type": "speech",
                    "text": text,
                    "lang": lang,
                    "ms": ms,
                    "energy": round(energy, 1),
                }
            )

    except KeyboardInterrupt:
        emit({"type": "status", "message": "Voice worker stopped"})
        return 0
    except Exception as e:
        emit({"type": "error", "message": str(e)})
        return 1
    finally:
        stop_flag.set()
        try:
            stream.stop_stream()
            stream.close()
        except Exception:
            pass
        try:
            p.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(main())
