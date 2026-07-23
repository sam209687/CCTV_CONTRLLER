#!/usr/bin/env python3
"""Inspect the newest finalized CCTV MP4 safely.

Selection rules:
1. Ignore *.partial.mp4 files.
2. Select by st_mtime_ns, not text-formatted timestamps.
3. Optionally restrict selection to one camera ID.
4. Read the matching JSON metadata only after selecting the MP4.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Inspect the newest finalized CCTV recording."
        ),
    )

    parser.add_argument(
        "--recordings-dir",
        default=str(
            Path.home()
            / "CCTV_Recordings"
        ),
    )

    parser.add_argument(
        "--camera-id",
        default=None,
    )

    parser.add_argument(
        "--path",
        default=None,
        help=(
            "Inspect this exact finalized MP4 instead "
            "of auto-selecting the newest one."
        ),
    )

    parser.add_argument(
        "--recent",
        type=int,
        default=5,
        help=(
            "Number of recent finalized files to include "
            "in the selection report."
        ),
    )

    return parser.parse_args()


def is_finalized_mp4(path: Path) -> bool:
    name = path.name.lower()

    return (
        path.is_file()
        and name.endswith(".mp4")
        and not name.endswith(".partial.mp4")
    )


def matches_camera(
    path: Path,
    camera_id: str | None,
) -> bool:
    if not camera_id:
        return True

    normalized = camera_id.strip()

    if not normalized:
        return True

    return (
        path.name.startswith(
            f"{normalized}_"
        )
        or normalized in path.parts
    )


def select_recording(
    recordings_root: Path,
    camera_id: str | None,
    explicit_path: str | None,
) -> tuple[Path, list[dict[str, Any]]]:
    if explicit_path:
        selected = Path(
            explicit_path
        ).expanduser().resolve()

        if not is_finalized_mp4(
            selected
        ):
            raise RuntimeError(
                "The requested file is missing, is not an MP4, "
                "or is still a .partial.mp4 file: "
                f"{selected}"
            )

        stat = selected.stat()

        return (
            selected,
            [
                {
                    "path": str(selected),
                    "mtimeNs": stat.st_mtime_ns,
                    "sizeBytes": stat.st_size,
                }
            ],
        )

    candidates = [
        path
        for path in recordings_root.rglob(
            "*.mp4"
        )
        if (
            is_finalized_mp4(path)
            and matches_camera(
                path,
                camera_id,
            )
        )
    ]

    candidates.sort(
        key=lambda path: (
            path.stat().st_mtime_ns,
            str(path),
        ),
        reverse=True,
    )

    if not candidates:
        scope = (
            f" for camera {camera_id}"
            if camera_id
            else ""
        )

        raise RuntimeError(
            "No finalized MP4 recording was found"
            f"{scope} under {recordings_root}."
        )

    recent = []

    for path in candidates:
        stat = path.stat()

        recent.append(
            {
                "path": str(path),
                "mtimeNs": stat.st_mtime_ns,
                "sizeBytes": stat.st_size,
            }
        )

    return candidates[0], recent


def probe_recording(
    path: Path,
) -> dict[str, Any]:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        (
            "format=duration,size:"
            "stream=codec_name,width,height,avg_frame_rate"
        ),
        "-of",
        "json",
        str(path),
    ]

    completed = subprocess.run(
        command,
        text=True,
        capture_output=True,
    )

    if completed.returncode != 0:
        raise RuntimeError(
            "ffprobe failed for "
            f"{path}: "
            f"{completed.stderr.strip()}"
        )

    return json.loads(
        completed.stdout
    )


def read_metadata(
    mp4_path: Path,
) -> tuple[Path, dict[str, Any] | None]:
    metadata_path = (
        mp4_path.with_suffix(
            ".json"
        )
    )

    if not metadata_path.is_file():
        return metadata_path, None

    try:
        metadata = json.loads(
            metadata_path.read_text(
                encoding="utf-8",
            )
        )
    except json.JSONDecodeError as error:
        raise RuntimeError(
            "The matching metadata JSON is invalid: "
            f"{metadata_path}: {error}"
        ) from error

    return metadata_path, metadata


def partial_file_report(
    recordings_root: Path,
    camera_id: str | None,
) -> list[dict[str, Any]]:
    partials = [
        path
        for path in recordings_root.rglob(
            "*.partial.mp4"
        )
        if (
            path.is_file()
            and matches_camera(
                path,
                camera_id,
            )
        )
    ]

    partials.sort(
        key=lambda path: (
            path.stat().st_mtime_ns,
            str(path),
        ),
        reverse=True,
    )

    return [
        {
            "path": str(path),
            "mtimeNs": path.stat().st_mtime_ns,
            "sizeBytes": path.stat().st_size,
        }
        for path in partials
    ]


def main() -> int:
    args = parse_args()

    recordings_root = Path(
        args.recordings_dir
    ).expanduser().resolve()

    if (
        not recordings_root.is_dir()
        and not args.path
    ):
        print(
            "Recordings directory not found: "
            f"{recordings_root}",
            file=sys.stderr,
        )

        return 2

    try:
        selected, candidates = (
            select_recording(
                recordings_root,
                args.camera_id,
                args.path,
            )
        )

        probe = probe_recording(
            selected
        )

        (
            metadata_path,
            metadata,
        ) = read_metadata(
            selected
        )

        partials = partial_file_report(
            recordings_root,
            args.camera_id,
        )
    except Exception as error:
        print(
            f"Recording inspection failed: {error}",
            file=sys.stderr,
        )

        return 1

    selected_stat = selected.stat()

    report = {
        "ok": True,
        "selection": {
            "method": (
                "explicit-path"
                if args.path
                else "newest-finalized-mtime-ns"
            ),
            "cameraIdFilter": args.camera_id,
            "recordingsRoot": str(
                recordings_root
            ),
            "selectedPath": str(
                selected
            ),
            "selectedMtimeNs": (
                selected_stat.st_mtime_ns
            ),
            "selectedSizeBytes": (
                selected_stat.st_size
            ),
            "recentFinalized": candidates[
                : max(
                    1,
                    args.recent,
                )
            ],
            "ignoredPartialCount": len(
                partials
            ),
            "recentPartials": partials[
                :3
            ],
        },
        "ffprobe": probe,
        "metadataPath": str(
            metadata_path
        ),
        "metadata": metadata,
    }

    if metadata:
        recorded_path = metadata.get(
            "filePath"
        )

        report[
            "metadataMatchesSelectedFile"
        ] = (
            not recorded_path
            or Path(
                recorded_path
            ).expanduser().resolve()
            == selected
        )
    else:
        report[
            "metadataMatchesSelectedFile"
        ] = None

    print(
        "Latest finalized recording:"
    )
    print(
        selected
    )

    print()

    print(
        json.dumps(
            report,
            indent=2,
        )
    )

    if (
        report[
            "metadataMatchesSelectedFile"
        ]
        is False
    ):
        print(
            "\nWARNING: metadata filePath does not "
            "match the selected MP4.",
            file=sys.stderr,
        )

        return 3

    return 0


if __name__ == "__main__":
    raise SystemExit(
        main()
    )
