#!/usr/bin/env python3
"""Verify the integrated HOLD firmware from its serial smoke output."""

from __future__ import annotations

import argparse
import re
import sys
import time

import serial


def value(line: str, name: str) -> str:
    match = re.search(rf"(?:^|[ |]){re.escape(name)}=([^ |]+)", line)
    return match.group(1) if match else ""


def evaluate(lines: list[str]) -> dict[str, bool]:
    frames = [line for line in lines if line.startswith("[smoke] up=")]
    return {
        "i2c": any("57=Y" in line and "68=Y" in line and "5A=Y" in line for line in lines),
        "imu": any(value(line, "imu") == "OK" for line in frames),
        "ppg": any(value(line, "ppg") == "OK" and int(value(line, "ir") or 0) > 0 for line in frames),
        "pressure": any(value(line, "pressure") == "OK" for line in frames),
        "haptic": any("motor=OK" in line for line in lines),
        "heart": any(35 <= float(value(line, "bpm") or 0) <= 220 and "contact=Y" in line for line in frames),
        "breath": any(6 <= float(value(line, "breath") or 0) <= 45 and value(line, "src") in {"imu", "pressure"} for line in frames),
    }


def self_test() -> None:
    result = evaluate([
        "[smoke] init | i2c 57=Y 68=Y 69=N 5A=Y | imu=OK | ppg=OK | pressure=OK | motor=OK",
        "[smoke] up=100 | imu=OK | ppg=OK err=ok ir=120000 red=90000 bpm=72 beat=Y contact=Y | pressure=OK raw=900 level=2 | breath=14 src=imu status=valid",
    ])
    assert all(result.values()), result


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify HOLD integrated sensor and vital stream.")
    parser.add_argument("--port", default="COM13")
    parser.add_argument("--duration", type=float, default=20)
    parser.add_argument("--require-vitals", action="store_true", help="Require valid heart and respiration values while worn.")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        print("integrated stream verifier self-test: ok")
        return 0

    lines: list[str] = []
    try:
        with serial.Serial(args.port, 115200, timeout=0.2) as stream:
            stream.dtr = False
            stream.rts = False
            deadline = time.monotonic() + args.duration
            while time.monotonic() < deadline:
                raw = stream.readline()
                if raw:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if line.startswith("[smoke]"):
                        lines.append(line)
    except serial.SerialException as error:
        print(f"[FAIL] serial: {error}", file=sys.stderr)
        return 2

    result = evaluate(lines)
    required = ["i2c", "imu", "ppg", "pressure", "haptic"]
    if args.require_vitals:
        required += ["heart", "breath"]
    for name in ["i2c", "imu", "ppg", "pressure", "haptic", "heart", "breath"]:
        print(f"[{'PASS' if result[name] else 'WAIT'}] {name}")
    missing = [name for name in required if not result[name]]
    if missing:
        print("[FAIL] missing: " + ", ".join(missing))
        return 1
    print("[PASS] integrated HOLD stream")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
