#!/usr/bin/env python3
"""Continuous local CCTV recorder for a LiveKit camera participant.

The worker joins one LiveKit room as a hidden subscribe-only participant,
normalizes changing simulcast resolutions into a fixed canvas, writes
crash-tolerant fragmented MP4 partials, and finalizes each segment as a
normal fast-start MP4.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import fcntl
import json
import logging
import os
import re
import shutil
import signal
import sys
import tempfile
import time
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from fractions import Fraction
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from livekit import api, rtc
from PIL import Image, ImageOps


LOG = logging.getLogger("cctv-continuous-recorder")
TERMINAL_ROOM_REASONS = {"operator-stop", "max-segments"}


class CameraUnavailable(RuntimeError):
    """Raised when the camera or its video track becomes unavailable."""


@dataclass(frozen=True)
class RecorderConfig:
    camera_id: str
    room_name: str
    camera_identity: str
    recordings_root: Path
    runtime_dir: Path
    segment_seconds: int
    reconnect_seconds: float
    wait_for_camera_seconds: int
    no_frame_timeout_seconds: int
    minimum_segment_seconds: float
    fps_hint: float
    crf: int
    output_width: int
    output_height: int
    display_mode: str
    fit_mode: str
    max_segments: int


@dataclass
class SegmentResult:
    path: Path | None
    metadata_path: Path | None
    duration_seconds: float
    frame_count: int
    termination_reason: str
    finalized: bool


def iso_now() -> str:
    return datetime.now().astimezone().isoformat()


def local_now() -> datetime:
    return datetime.now().astimezone()


def file_time(value: datetime) -> str:
    return value.strftime("%Y-%m-%d_%H-%M-%S-%f")[:-3]


def clean_camera_id(value: str) -> str:
    normalized = re.sub(
        r"[^a-z0-9._-]",
        "_",
        str(value or "").strip().lower(),
    )[:120]

    if not normalized:
        raise ValueError("Camera ID is required.")

    return normalized


def required_environment(name: str) -> str:
    value = str(os.getenv(name, "")).strip()

    if not value:
        raise RuntimeError(
            f"Missing required environment variable: {name}"
        )

    return value


def even_dimension(value: int, name: str) -> int:
    if value < 2:
        raise ValueError(f"{name} must be at least 2.")

    return value - (value % 2)


def fps_number(value: str | None) -> float | None:
    if not value or value == "0/0":
        return None

    try:
        return float(Fraction(value))
    except (ValueError, ZeroDivisionError):
        return None


def companion_ffmpeg_log(partial_path: Path) -> Path:
    name = partial_path.name

    if name.endswith(".partial.mp4"):
        return partial_path.with_name(
            name.removesuffix(".partial.mp4") + ".ffmpeg.log"
        )

    return partial_path.with_suffix(".ffmpeg.log")


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(
        f".{path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    )
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


async def index_local_metadata(metadata_path: Path) -> dict[str, Any] | None:
    enabled = str(
        os.getenv("CCTV_RECORDING_AUTO_INDEX", "true")
    ).strip().lower() not in {"0", "false", "no", "off"}

    if not enabled:
        return None

    project_root = Path(__file__).resolve().parents[1]
    script = project_root / "scripts" / "index_local_recordings.js"

    if not script.is_file():
        LOG.warning("Recording index script is missing: %s", script)
        return None

    try:
        process = await asyncio.create_subprocess_exec(
            str(os.getenv("CCTV_RECORDING_INDEX_NODE", "node")),
            str(script),
            "--metadata",
            str(metadata_path),
            "--json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            raise RuntimeError(
                stderr.decode("utf-8", errors="replace").strip()
                or stdout.decode("utf-8", errors="replace").strip()
                or f"indexer exited with code {process.returncode}"
            )

        payload = json.loads(stdout.decode("utf-8"))
        LOG.info(
            "Indexed segment in SQLite: %s",
            metadata_path,
        )
        return payload
    except Exception as error:
        LOG.exception(
            "Segment finalized but SQLite indexing failed for %s: %s",
            metadata_path,
            error,
        )
        return None


def normalize_rgb_frame(
    frame: rtc.VideoFrame,
    rotation: int,
    output_width: int,
    output_height: int,
    fit_mode: str,
) -> bytes:
    source_width = int(frame.width)
    source_height = int(frame.height)
    raw = bytes(frame.data)
    expected_size = source_width * source_height * 3

    if len(raw) != expected_size:
        raise RuntimeError(
            "Unexpected RGB24 frame size: "
            f"received {len(raw)} bytes, expected {expected_size} "
            f"for {source_width}x{source_height}."
        )

    image = Image.frombytes(
        "RGB",
        (source_width, source_height),
        raw,
    )

    if rotation == 1:
        image = image.transpose(Image.Transpose.ROTATE_270)
    elif rotation == 2:
        image = image.transpose(Image.Transpose.ROTATE_180)
    elif rotation == 3:
        image = image.transpose(Image.Transpose.ROTATE_90)

    if fit_mode == "cover":
        return ImageOps.fit(
            image,
            (output_width, output_height),
            method=Image.Resampling.BILINEAR,
            centering=(0.5, 0.5),
        ).tobytes()

    if fit_mode != "contain":
        raise ValueError("Fit mode must be contain or cover.")

    contained = ImageOps.contain(
        image,
        (output_width, output_height),
        method=Image.Resampling.BILINEAR,
    )

    if contained.size == (output_width, output_height):
        return contained.tobytes()

    canvas = Image.new(
        "RGB",
        (output_width, output_height),
        "black",
    )
    canvas.paste(
        contained,
        (
            (output_width - contained.width) // 2,
            (output_height - contained.height) // 2,
        ),
    )
    return canvas.tobytes()


async def probe_video(path: Path) -> dict[str, Any]:
    process = await asyncio.create_subprocess_exec(
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        (
            "format=duration,size,start_time:"
            "stream=codec_name,width,height,avg_frame_rate,start_time"
        ),
        "-of",
        "json",
        str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()

    if process.returncode != 0:
        raise RuntimeError(
            "ffprobe failed for "
            f"{path}: "
            + stderr.decode("utf-8", errors="replace").strip()
        )

    data = json.loads(stdout.decode("utf-8"))
    stream = (data.get("streams") or [{}])[0]
    format_info = data.get("format") or {}

    return {
        "codec": stream.get("codec_name"),
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "averageFps": fps_number(stream.get("avg_frame_rate")),
        "startTimeSeconds": float(
            stream.get("start_time")
            or format_info.get("start_time")
            or 0
        ),
        "durationSeconds": float(format_info.get("duration") or 0),
        "sizeBytes": int(
            format_info.get("size") or path.stat().st_size
        ),
    }


async def close_process(
    process: asyncio.subprocess.Process,
    timeout_seconds: float = 30,
) -> int:
    if process.stdin is not None:
        try:
            process.stdin.close()
            await process.stdin.wait_closed()
        except (BrokenPipeError, ConnectionResetError):
            pass

    try:
        return await asyncio.wait_for(
            process.wait(),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError:
        process.terminate()

        try:
            return await asyncio.wait_for(
                process.wait(),
                timeout=10,
            )
        except asyncio.TimeoutError:
            process.kill()
            return await process.wait()


class StatusWriter:
    def __init__(self, path: Path, config: RecorderConfig) -> None:
        self.path = path
        self.config = config
        self.base: dict[str, Any] = {
            "schemaVersion": 1,
            "phase": "11I-L2",
            "cameraId": config.camera_id,
            "roomName": config.room_name,
            "cameraIdentity": config.camera_identity,
            "segmentSeconds": config.segment_seconds,
            "displayMode": config.display_mode,
            "fitMode": config.fit_mode,
            "outputWidth": config.output_width,
            "outputHeight": config.output_height,
            "pid": os.getpid(),
            "startedAt": iso_now(),
        }

    def update(self, state: str, **values: Any) -> None:
        payload = {
            **self.base,
            "state": state,
            "updatedAt": iso_now(),
            **values,
        }
        atomic_write_json(self.path, payload)


class ProcessLock:
    def __init__(self, lock_path: Path, pid_path: Path) -> None:
        self.lock_path = lock_path
        self.pid_path = pid_path
        self.handle: Any | None = None

    def __enter__(self) -> "ProcessLock":
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.lock_path.open("a+", encoding="utf-8")

        try:
            fcntl.flock(
                self.handle.fileno(),
                fcntl.LOCK_EX | fcntl.LOCK_NB,
            )
        except BlockingIOError as error:
            raise RuntimeError(
                "Another continuous recorder already owns the lock: "
                f"{self.lock_path}"
            ) from error

        self.handle.seek(0)
        self.handle.truncate()
        self.handle.write(f"{os.getpid()}\n")
        self.handle.flush()
        self.pid_path.write_text(f"{os.getpid()}\n", encoding="utf-8")
        return self

    def __exit__(self, *_: Any) -> None:
        with contextlib.suppress(FileNotFoundError):
            self.pid_path.unlink()

        if self.handle is not None:
            with contextlib.suppress(OSError):
                self.handle.seek(0)
                self.handle.truncate()
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
            self.handle.close()
            self.handle = None


class ContinuousRecorder:
    def __init__(self, config: RecorderConfig) -> None:
        self.config = config
        self.stop_event = asyncio.Event()
        self.completed_segments = 0
        self.reconnect_count = 0
        self.status = StatusWriter(
            config.runtime_dir / "continuous_recorder_status.json",
            config,
        )

    def request_stop(self) -> None:
        if not self.stop_event.is_set():
            LOG.info("Stop requested; finalizing the active segment.")
            self.stop_event.set()

    def create_token(self) -> str:
        api_key = required_environment("LIVEKIT_API_KEY")
        api_secret = required_environment("LIVEKIT_API_SECRET")
        identity = (
            f"recorder:{self.config.camera_id}:"
            f"{uuid.uuid4().hex[:12]}"
        )

        return (
            api.AccessToken(api_key, api_secret)
            .with_identity(identity)
            .with_name(
                f"Continuous recorder {self.config.camera_id}"
            )
            .with_metadata(
                json.dumps(
                    {
                        "role": "continuous-local-recorder",
                        "cameraId": self.config.camera_id,
                        "phase": "11I-L2",
                    },
                    separators=(",", ":"),
                )
            )
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=self.config.room_name,
                    can_publish=False,
                    can_subscribe=True,
                    can_publish_data=False,
                    hidden=True,
                )
            )
            .to_jwt()
        )

    async def run(self) -> None:
        recovery = await self.recover_stale_partials()
        self.status.update(
            "STARTING",
            completedSegments=0,
            reconnectCount=0,
            recovery=recovery,
        )

        while not self.stop_event.is_set():
            if (
                self.config.max_segments > 0
                and self.completed_segments >= self.config.max_segments
            ):
                LOG.info(
                    "Maximum segment count reached: %s",
                    self.config.max_segments,
                )
                break

            try:
                await self.run_room_session()
            except CameraUnavailable as error:
                if self.stop_event.is_set():
                    break

                self.reconnect_count += 1
                LOG.warning("Camera unavailable: %s", error)
                self.status.update(
                    "WAITING_CAMERA",
                    completedSegments=self.completed_segments,
                    reconnectCount=self.reconnect_count,
                    lastError=str(error),
                    retryInSeconds=self.config.reconnect_seconds,
                )
                await self.sleep_or_stop(self.config.reconnect_seconds)
            except Exception as error:
                if self.stop_event.is_set():
                    break

                self.reconnect_count += 1
                LOG.exception("Recorder session failed: %s", error)
                self.status.update(
                    "ERROR_RETRYING",
                    completedSegments=self.completed_segments,
                    reconnectCount=self.reconnect_count,
                    lastError=str(error),
                    retryInSeconds=self.config.reconnect_seconds,
                )
                await self.sleep_or_stop(self.config.reconnect_seconds)

        self.status.update(
            "STOPPED",
            completedSegments=self.completed_segments,
            reconnectCount=self.reconnect_count,
            stoppedAt=iso_now(),
        )

    async def sleep_or_stop(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(
                self.stop_event.wait(),
                timeout=seconds,
            )
        except asyncio.TimeoutError:
            pass

    async def run_room_session(self) -> None:
        room = rtc.Room()
        track_queue: asyncio.Queue[tuple[Any, Any]] = asyncio.Queue(
            maxsize=1
        )
        session_lost = asyncio.Event()
        loss_reason = {"value": "camera-session-ended"}

        @room.on("track_subscribed")
        def on_track_subscribed(track, publication, participant) -> None:
            if (
                participant.identity == self.config.camera_identity
                and track.kind == rtc.TrackKind.KIND_VIDEO
                and track_queue.empty()
            ):
                if getattr(publication, "simulcasted", False):
                    try:
                        publication.set_video_quality(
                            rtc.VideoQuality.VIDEO_QUALITY_HIGH
                        )
                        LOG.info(
                            "Requested HIGH simulcast layer for track %s",
                            publication.sid,
                        )
                    except Exception:
                        LOG.exception(
                            "Could not request the HIGH simulcast layer."
                        )

                track_queue.put_nowait((track, publication))

        @room.on("track_unsubscribed")
        def on_track_unsubscribed(track, publication, participant) -> None:
            if (
                participant.identity == self.config.camera_identity
                and track.kind == rtc.TrackKind.KIND_VIDEO
            ):
                loss_reason["value"] = "camera-track-unsubscribed"
                session_lost.set()

        @room.on("participant_disconnected")
        def on_participant_disconnected(participant) -> None:
            if participant.identity == self.config.camera_identity:
                loss_reason["value"] = "camera-participant-disconnected"
                session_lost.set()

        @room.on("disconnected")
        def on_disconnected(reason) -> None:
            loss_reason["value"] = f"recorder-room-disconnected:{reason}"
            session_lost.set()

        livekit_url = required_environment("LIVEKIT_URL")
        self.status.update(
            "CONNECTING",
            completedSegments=self.completed_segments,
            reconnectCount=self.reconnect_count,
            livekitUrl=livekit_url,
        )

        LOG.info("Connecting to room %s", self.config.room_name)
        await room.connect(
            livekit_url,
            self.create_token(),
            rtc.RoomOptions(auto_subscribe=True),
        )

        stream: rtc.VideoStream | None = None

        try:
            self.status.update(
                "WAITING_TRACK",
                completedSegments=self.completed_segments,
                reconnectCount=self.reconnect_count,
            )

            track_task = asyncio.create_task(track_queue.get())
            stop_task = asyncio.create_task(self.stop_event.wait())
            lost_task = asyncio.create_task(session_lost.wait())

            done, pending = await asyncio.wait(
                {track_task, stop_task, lost_task},
                timeout=self.config.wait_for_camera_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )

            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

            if not done:
                raise CameraUnavailable(
                    "Camera video track did not arrive within "
                    f"{self.config.wait_for_camera_seconds}s."
                )

            if stop_task in done and stop_task.result():
                return

            if lost_task in done and lost_task.result():
                raise CameraUnavailable(loss_reason["value"])

            track, publication = track_task.result()
            stream = rtc.VideoStream(
                track,
                capacity=3,
                format=rtc.VideoBufferType.RGB24,
            )

            while not self.stop_event.is_set() and not session_lost.is_set():
                if (
                    self.config.max_segments > 0
                    and self.completed_segments >= self.config.max_segments
                ):
                    return

                result = await self.record_one_segment(
                    stream=stream,
                    publication=publication,
                    session_lost=session_lost,
                    loss_reason=loss_reason,
                )

                if result.finalized:
                    self.completed_segments += 1

                if result.termination_reason != "segment-duration":
                    if result.termination_reason in TERMINAL_ROOM_REASONS:
                        return
                    raise CameraUnavailable(result.termination_reason)
        finally:
            if stream is not None:
                with contextlib.suppress(Exception):
                    await stream.aclose()
            with contextlib.suppress(Exception):
                await room.disconnect()

    async def record_one_segment(
        self,
        *,
        stream: rtc.VideoStream,
        publication: Any,
        session_lost: asyncio.Event,
        loss_reason: dict[str, str],
    ) -> SegmentResult:
        try:
            first_event = await asyncio.wait_for(
                stream.__anext__(),
                timeout=self.config.no_frame_timeout_seconds,
            )
        except asyncio.TimeoutError as error:
            raise CameraUnavailable(
                "No camera frame arrived before segment start."
            ) from error
        except StopAsyncIteration as error:
            raise CameraUnavailable(
                "Camera video track ended before segment start."
            ) from error

        started_at = local_now()
        target_dir = (
            self.config.recordings_root
            / self.config.camera_id
            / started_at.strftime("%Y")
            / started_at.strftime("%m")
            / started_at.strftime("%d")
        )
        target_dir.mkdir(parents=True, exist_ok=True, mode=0o750)

        stem = f"{self.config.camera_id}_{file_time(started_at)}"
        partial_path = target_dir / f"{stem}.partial.mp4"
        ffmpeg_log_path = target_dir / f"{stem}.ffmpeg.log"
        ffmpeg_log_handle = ffmpeg_log_path.open("wb")

        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-video_size",
            f"{self.config.output_width}x{self.config.output_height}",
            "-framerate",
            f"{self.config.fps_hint:g}",
            "-use_wallclock_as_timestamps",
            "1",
            "-i",
            "pipe:0",
            "-an",
            "-vf",
            "setpts=PTS-STARTPTS",
            "-fps_mode",
            "vfr",
            "-avoid_negative_ts",
            "make_zero",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
            "-crf",
            str(self.config.crf),
            "-maxrate",
            "1500k",
            "-bufsize",
            "3000k",
            "-pix_fmt",
            "yuv420p",
            "-video_track_timescale",
            "90000",
            "-movflags",
            "+frag_keyframe+empty_moov+default_base_moof",
            str(partial_path),
        ]

        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=ffmpeg_log_handle,
        )

        if process.stdin is None:
            ffmpeg_log_handle.close()
            raise RuntimeError("FFmpeg stdin was not created.")

        frame_count = 0
        first_timestamp_us: int | None = None
        last_timestamp_us: int | None = None
        source_resolutions: Counter[str] = Counter()
        source_rotations: Counter[str] = Counter()
        last_signature: tuple[int, int, int] | None = None
        started_monotonic = time.monotonic()
        deadline = started_monotonic + self.config.segment_seconds
        termination_reason = "segment-duration"

        self.status.update(
            "RECORDING",
            completedSegments=self.completed_segments,
            reconnectCount=self.reconnect_count,
            currentSegmentIndex=self.completed_segments + 1,
            currentSegmentStartedAt=started_at.isoformat(),
            currentPartialPath=str(partial_path),
            currentFrameCount=0,
            currentElapsedSeconds=0,
        )

        async def write_event(event: Any) -> None:
            nonlocal frame_count
            nonlocal first_timestamp_us
            nonlocal last_timestamp_us
            nonlocal last_signature

            frame = event.frame
            source_width = int(frame.width)
            source_height = int(frame.height)
            rotation = int(event.rotation)
            signature = (source_width, source_height, rotation)

            source_resolutions[f"{source_width}x{source_height}"] += 1
            source_rotations[str(rotation)] += 1

            if signature != last_signature:
                LOG.info(
                    "Input layer %sx%s rotation=%s -> %sx%s %s",
                    source_width,
                    source_height,
                    rotation,
                    self.config.output_width,
                    self.config.output_height,
                    self.config.fit_mode,
                )
                last_signature = signature

            normalized = normalize_rgb_frame(
                frame,
                rotation,
                self.config.output_width,
                self.config.output_height,
                self.config.fit_mode,
            )

            try:
                process.stdin.write(normalized)
                await process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as error:
                raise RuntimeError(
                    "FFmpeg stopped accepting normalized frames. "
                    f"Read {ffmpeg_log_path}."
                ) from error

            frame_count += 1
            timestamp_us = int(event.timestamp_us)
            if first_timestamp_us is None:
                first_timestamp_us = timestamp_us
            last_timestamp_us = timestamp_us

            if frame_count % max(1, round(self.config.fps_hint * 10)) == 0:
                elapsed = time.monotonic() - started_monotonic
                LOG.info(
                    "Segment %s: %s frames, %.1fs elapsed",
                    self.completed_segments + 1,
                    frame_count,
                    elapsed,
                )
                self.status.update(
                    "RECORDING",
                    completedSegments=self.completed_segments,
                    reconnectCount=self.reconnect_count,
                    currentSegmentIndex=self.completed_segments + 1,
                    currentSegmentStartedAt=started_at.isoformat(),
                    currentPartialPath=str(partial_path),
                    currentFrameCount=frame_count,
                    currentElapsedSeconds=round(elapsed, 1),
                    lastFrameAt=iso_now(),
                )

        LOG.info(
            "Starting segment %s: %ss, %sx%s, mode=%s, fit=%s",
            self.completed_segments + 1,
            self.config.segment_seconds,
            self.config.output_width,
            self.config.output_height,
            self.config.display_mode,
            self.config.fit_mode,
        )

        try:
            await write_event(first_event)

            while True:
                now = time.monotonic()

                if self.stop_event.is_set():
                    termination_reason = "operator-stop"
                    break

                if session_lost.is_set():
                    termination_reason = loss_reason["value"]
                    break

                if now >= deadline:
                    termination_reason = "segment-duration"
                    break

                timeout = min(
                    float(self.config.no_frame_timeout_seconds),
                    max(0.1, deadline - now),
                )

                try:
                    event = await asyncio.wait_for(
                        stream.__anext__(),
                        timeout=timeout,
                    )
                except asyncio.TimeoutError:
                    if time.monotonic() >= deadline:
                        termination_reason = "segment-duration"
                        break
                    if self.stop_event.is_set():
                        termination_reason = "operator-stop"
                        break
                    if session_lost.is_set():
                        termination_reason = loss_reason["value"]
                        break
                    termination_reason = "camera-frame-timeout"
                    break
                except StopAsyncIteration:
                    termination_reason = "camera-track-ended"
                    break

                await write_event(event)
        finally:
            return_code = await close_process(process)
            ffmpeg_log_handle.close()

        if return_code != 0:
            quarantined = await self.quarantine_partial(
                partial_path,
                ffmpeg_log_path,
                reason=f"ffmpeg-exit-{return_code}",
            )
            raise RuntimeError(
                "FFmpeg exited with code "
                f"{return_code}. Partial moved to {quarantined}."
            )

        elapsed_wall = time.monotonic() - started_monotonic
        self.status.update(
            "FINALIZING",
            completedSegments=self.completed_segments,
            reconnectCount=self.reconnect_count,
            currentSegmentIndex=self.completed_segments + 1,
            currentPartialPath=str(partial_path),
            currentFrameCount=frame_count,
            currentElapsedSeconds=round(elapsed_wall, 1),
            terminationReason=termination_reason,
        )

        result = await self.finalize_segment(
            partial_path=partial_path,
            ffmpeg_log_path=ffmpeg_log_path,
            publication=publication,
            started_at=started_at,
            frame_count=frame_count,
            first_timestamp_us=first_timestamp_us,
            last_timestamp_us=last_timestamp_us,
            source_resolutions=source_resolutions,
            source_rotations=source_rotations,
            termination_reason=termination_reason,
            wall_clock_elapsed=elapsed_wall,
        )

        self.status.update(
            "SEGMENT_FINALIZED",
            completedSegments=(
                self.completed_segments + 1
                if result.finalized
                else self.completed_segments
            ),
            reconnectCount=self.reconnect_count,
            lastFinalizedPath=(str(result.path) if result.path else None),
            lastSegmentDurationSeconds=result.duration_seconds,
            lastSegmentFrameCount=result.frame_count,
            lastTerminationReason=result.termination_reason,
        )
        return result

    async def finalize_segment(
        self,
        *,
        partial_path: Path,
        ffmpeg_log_path: Path,
        publication: Any,
        started_at: datetime,
        frame_count: int,
        first_timestamp_us: int | None,
        last_timestamp_us: int | None,
        source_resolutions: Counter[str],
        source_rotations: Counter[str],
        termination_reason: str,
        wall_clock_elapsed: float,
    ) -> SegmentResult:
        try:
            partial_probe = await probe_video(partial_path)
        except Exception as error:
            quarantined = await self.quarantine_partial(
                partial_path,
                ffmpeg_log_path,
                reason="partial-probe-failed",
            )
            raise RuntimeError(
                "Could not inspect the partial segment. "
                f"Moved to {quarantined}: {error}"
            ) from error

        if (
            partial_probe["durationSeconds"]
            < self.config.minimum_segment_seconds
        ):
            quarantined = await self.quarantine_partial(
                partial_path,
                ffmpeg_log_path,
                reason="segment-too-short",
            )
            LOG.warning(
                "Discarded short segment %.2fs to %s",
                partial_probe["durationSeconds"],
                quarantined,
            )
            return SegmentResult(
                path=None,
                metadata_path=None,
                duration_seconds=partial_probe["durationSeconds"],
                frame_count=frame_count,
                termination_reason=termination_reason,
                finalized=False,
            )

        ended_at = local_now()
        suffix = ""
        if termination_reason == "operator-stop":
            suffix = "_stopped"
        elif termination_reason != "segment-duration":
            suffix = "_interrupted"

        final_path = partial_path.with_name(
            f"{self.config.camera_id}_{file_time(started_at)}"
            f"_to_{ended_at.strftime('%H-%M-%S-%f')[:-3]}"
            f"{suffix}.mp4"
        )
        finalizing_path = final_path.with_name(
            f".{final_path.name}.finalizing.mp4"
        )

        remux_log_path = final_path.with_suffix(".remux.log")
        remux_log_handle = remux_log_path.open("wb")
        remux_command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-i",
            str(partial_path),
            "-map",
            "0:v:0",
            "-an",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            "-video_track_timescale",
            "90000",
            "-movflags",
            "+faststart",
            str(finalizing_path),
        ]
        remux_process = await asyncio.create_subprocess_exec(
            *remux_command,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=remux_log_handle,
        )
        remux_return_code = await remux_process.wait()
        remux_log_handle.close()

        if remux_return_code != 0:
            with contextlib.suppress(FileNotFoundError):
                finalizing_path.unlink()
            quarantined = await self.quarantine_partial(
                partial_path,
                ffmpeg_log_path,
                reason=f"remux-exit-{remux_return_code}",
            )
            raise RuntimeError(
                "Segment remux failed. Partial moved to "
                f"{quarantined}; read {remux_log_path}."
            )

        final_probe = await probe_video(finalizing_path)

        if final_probe["codec"] != "h264":
            raise RuntimeError(
                f"Final segment codec is {final_probe['codec']}, not H.264."
            )

        if not -0.1 <= final_probe["startTimeSeconds"] <= 1.0:
            raise RuntimeError(
                "Final segment does not begin near timestamp zero: "
                f"{final_probe['startTimeSeconds']:.3f}s."
            )

        finalizing_path.replace(final_path)
        with contextlib.suppress(FileNotFoundError):
            partial_path.unlink()

        final_ffmpeg_log = final_path.with_suffix(".ffmpeg.log")
        if ffmpeg_log_path.exists():
            ffmpeg_log_path.replace(final_ffmpeg_log)

        metadata_path = final_path.with_suffix(".json")
        metadata = {
            "schemaVersion": 2,
            "phase": "11I-L2",
            "recordingMode": "CONTINUOUS_LOCAL_SEGMENT",
            "cameraId": self.config.camera_id,
            "fileName": final_path.name,
            "relativeFilePath": final_path.relative_to(
                self.config.recordings_root
            ).as_posix(),
            "storageRoot": str(self.config.recordings_root),
            "uploadedAt": ended_at.isoformat(),
            "roomName": self.config.room_name,
            "cameraIdentity": self.config.camera_identity,
            "trackSid": getattr(publication, "sid", None),
            "segmentIndex": self.completed_segments + 1,
            "segmentTargetSeconds": self.config.segment_seconds,
            "segmentCompletion": (
                "complete"
                if termination_reason == "segment-duration"
                else "partial-valid"
            ),
            "terminationReason": termination_reason,
            "startedAt": started_at.isoformat(),
            "endedAt": ended_at.isoformat(),
            "wallClockElapsedSeconds": round(wall_clock_elapsed, 3),
            "frameCount": frame_count,
            "firstTimestampUs": first_timestamp_us,
            "lastTimestampUs": last_timestamp_us,
            "displayMode": self.config.display_mode,
            "fitMode": self.config.fit_mode,
            "outputWidth": self.config.output_width,
            "outputHeight": self.config.output_height,
            "sourceResolutionCounts": dict(sorted(source_resolutions.items())),
            "sourceRotationCounts": dict(sorted(source_rotations.items())),
            "filePath": str(final_path),
            "ffmpegLogPath": str(final_ffmpeg_log),
            "remuxLogPath": str(remux_log_path),
            **final_probe,
        }
        atomic_write_json(metadata_path, metadata)
        await index_local_metadata(metadata_path)

        LOG.info(
            "Finalized segment %s: %.2fs, %.2f MB, %s frames",
            final_path,
            final_probe["durationSeconds"],
            final_probe["sizeBytes"] / 1_048_576,
            frame_count,
        )

        return SegmentResult(
            path=final_path,
            metadata_path=metadata_path,
            duration_seconds=final_probe["durationSeconds"],
            frame_count=frame_count,
            termination_reason=termination_reason,
            finalized=True,
        )

    async def recover_stale_partials(self) -> dict[str, Any]:
        recovered: list[str] = []
        quarantined: list[str] = []
        errors: list[str] = []

        for partial_path in sorted(
            self.config.recordings_root.rglob("*.partial.mp4")
        ):
            try:
                recovered_path = await self.try_recover_partial(partial_path)
                if recovered_path is not None:
                    recovered.append(str(recovered_path))
                else:
                    quarantine_path = await self.quarantine_partial(
                        partial_path,
                        companion_ffmpeg_log(partial_path),
                        reason="stale-unrecoverable",
                    )
                    quarantined.append(str(quarantine_path))
            except Exception as error:
                errors.append(f"{partial_path}: {error}")

        return {
            "recoveredCount": len(recovered),
            "quarantinedCount": len(quarantined),
            "errorsCount": len(errors),
            "recovered": recovered,
            "quarantined": quarantined,
            "errors": errors,
        }

    async def try_recover_partial(self, partial_path: Path) -> Path | None:
        recovered_path = partial_path.with_name(
            partial_path.name.removesuffix(".partial.mp4")
            + "_recovered.mp4"
        )
        temporary_path = recovered_path.with_name(
            f".{recovered_path.name}.recovering.mp4"
        )
        recovery_log = recovered_path.with_suffix(".recovery.log")
        log_handle = recovery_log.open("wb")

        process = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-err_detect",
            "ignore_err",
            "-i",
            str(partial_path),
            "-map",
            "0:v:0",
            "-an",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            "-movflags",
            "+faststart",
            str(temporary_path),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=log_handle,
        )
        return_code = await process.wait()
        log_handle.close()

        if return_code != 0 or not temporary_path.is_file():
            with contextlib.suppress(FileNotFoundError):
                temporary_path.unlink()
            return None

        try:
            probe = await probe_video(temporary_path)
        except Exception:
            with contextlib.suppress(FileNotFoundError):
                temporary_path.unlink()
            return None

        if probe["durationSeconds"] < self.config.minimum_segment_seconds:
            with contextlib.suppress(FileNotFoundError):
                temporary_path.unlink()
            return None

        temporary_path.replace(recovered_path)
        with contextlib.suppress(FileNotFoundError):
            partial_path.unlink()

        metadata_path = recovered_path.with_suffix(".json")
        atomic_write_json(
            metadata_path,
            {
                "schemaVersion": 1,
                "phase": "11I-L2",
                "recordingMode": "RECOVERED_STALE_PARTIAL",
                "cameraId": self.config.camera_id,
                "fileName": recovered_path.name,
                "relativeFilePath": recovered_path.relative_to(
                    self.config.recordings_root
                ).as_posix(),
                "storageRoot": str(self.config.recordings_root),
                "recoveredAt": iso_now(),
                "filePath": str(recovered_path),
                **probe,
            },
        )
        await index_local_metadata(metadata_path)
        LOG.info("Recovered stale partial: %s", recovered_path)
        return recovered_path

    async def quarantine_partial(
        self,
        partial_path: Path,
        log_path: Path,
        *,
        reason: str,
    ) -> Path:
        timestamp = local_now()
        quarantine_dir = (
            self.config.recordings_root
            / "_Interrupted"
            / self.config.camera_id
            / timestamp.strftime("%Y-%m-%d")
        )
        quarantine_dir.mkdir(parents=True, exist_ok=True, mode=0o750)

        destination = quarantine_dir / partial_path.name
        if destination.exists():
            destination = quarantine_dir / (
                f"{partial_path.stem}_{uuid.uuid4().hex[:8]}"
                f"{partial_path.suffix}"
            )

        if partial_path.exists():
            shutil.move(str(partial_path), str(destination))

        if log_path.exists():
            if destination.name.endswith(".partial.mp4"):
                log_destination = destination.with_name(
                    destination.name.removesuffix(".partial.mp4")
                    + ".ffmpeg.log"
                )
            else:
                log_destination = destination.with_suffix(".ffmpeg.log")
            shutil.move(str(log_path), str(log_destination))

        reason_path = destination.with_suffix(".reason.json")
        atomic_write_json(
            reason_path,
            {
                "reason": reason,
                "quarantinedAt": iso_now(),
                "originalPath": str(partial_path),
                "quarantinedPath": str(destination),
            },
        )
        return destination


async def synthetic_self_test() -> int:
    with tempfile.TemporaryDirectory(prefix="cctv-l2-self-test-") as directory:
        root = Path(directory)
        partial = root / "segment.partial.mp4"
        final = root / "segment.mp4"
        log_path = root / "segment.log"
        log_handle = log_path.open("wb")

        process = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-video_size",
            "64x36",
            "-framerate",
            "8",
            "-use_wallclock_as_timestamps",
            "1",
            "-i",
            "pipe:0",
            "-an",
            "-vf",
            "setpts=PTS-STARTPTS",
            "-fps_mode",
            "vfr",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-video_track_timescale",
            "90000",
            "-movflags",
            "+frag_keyframe+empty_moov+default_base_moof",
            str(partial),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=log_handle,
        )

        assert process.stdin is not None
        frame = bytes(64 * 36 * 3)

        for _ in range(24):
            process.stdin.write(frame)
            await process.stdin.drain()
            await asyncio.sleep(0.125)

        return_code = await close_process(process)
        log_handle.close()
        if return_code != 0:
            raise RuntimeError("Synthetic fragmented MP4 creation failed.")

        remux = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(partial),
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            "-movflags",
            "+faststart",
            str(final),
        )
        if await remux.wait() != 0:
            raise RuntimeError("Synthetic MP4 remux failed.")

        probe = await probe_video(final)
        print(json.dumps({"ok": True, "selfTest": probe}, indent=2))

        if probe["codec"] != "h264":
            raise RuntimeError("Self-test output is not H.264.")
        if not -0.1 <= probe["startTimeSeconds"] <= 1.0:
            raise RuntimeError("Self-test timestamps do not begin near zero.")
        if probe["durationSeconds"] < 2.5:
            raise RuntimeError("Self-test duration is unexpectedly short.")

    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Continuously record a LiveKit smartphone camera into "
            "fixed-duration local MP4 segments."
        )
    )
    parser.add_argument("--env-file")
    parser.add_argument("--camera-id")
    parser.add_argument("--recordings-dir")
    parser.add_argument("--runtime-dir")
    parser.add_argument("--segment-seconds", type=int)
    parser.add_argument("--reconnect-seconds", type=float)
    parser.add_argument("--wait-seconds", type=int)
    parser.add_argument("--no-frame-timeout", type=int)
    parser.add_argument("--minimum-segment-seconds", type=float)
    parser.add_argument("--fps", type=float)
    parser.add_argument("--crf", type=int)
    parser.add_argument(
        "--display-mode",
        choices=("portrait", "landscape", "custom"),
    )
    parser.add_argument(
        "--fit-mode",
        choices=("contain", "cover"),
    )
    parser.add_argument("--output-width", type=int)
    parser.add_argument("--output-height", type=int)
    parser.add_argument("--max-segments", type=int, default=0)
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args()


def build_config(args: argparse.Namespace, project_root: Path) -> RecorderConfig:
    camera_id = clean_camera_id(
        args.camera_id
        or os.getenv("CCTV_RECORDER_CAMERA_ID", "cam-1772515015057")
    )
    display_mode = str(
        args.display_mode
        or os.getenv("CCTV_RECORDER_DISPLAY_MODE", "portrait")
    ).strip().lower()
    fit_mode = str(
        args.fit_mode
        or os.getenv("CCTV_RECORDER_FIT_MODE", "contain")
    ).strip().lower()

    if display_mode == "portrait":
        width = int(os.getenv("CCTV_RECORDER_PORTRAIT_WIDTH", "720"))
        height = int(os.getenv("CCTV_RECORDER_PORTRAIT_HEIGHT", "1280"))
    elif display_mode == "landscape":
        width = int(os.getenv("CCTV_RECORDER_LANDSCAPE_WIDTH", "1280"))
        height = int(os.getenv("CCTV_RECORDER_LANDSCAPE_HEIGHT", "720"))
    else:
        width = int(
            args.output_width
            or os.getenv("CCTV_RECORDER_OUTPUT_WIDTH", "720")
        )
        height = int(
            args.output_height
            or os.getenv("CCTV_RECORDER_OUTPUT_HEIGHT", "1280")
        )

    width = even_dimension(width, "Output width")
    height = even_dimension(height, "Output height")

    segment_seconds = int(
        args.segment_seconds
        or os.getenv("CCTV_RECORDER_SEGMENT_SECONDS", "1800")
    )
    if not 10 <= segment_seconds <= 10800:
        raise ValueError("Segment seconds must be between 10 and 10800.")

    max_segments = int(args.max_segments or 0)
    if max_segments < 0:
        raise ValueError("Max segments cannot be negative.")

    recordings_root = Path(
        args.recordings_dir
        or os.getenv(
            "CCTV_RECORDINGS_DIR",
            str(Path.home() / "CCTV_Recordings"),
        )
    ).expanduser().resolve()
    runtime_dir = Path(
        args.runtime_dir
        or os.getenv(
            "CCTV_RECORDER_RUNTIME_DIR",
            str(project_root / "runtime" / "cctv-recorder"),
        )
    ).expanduser().resolve()

    return RecorderConfig(
        camera_id=camera_id,
        room_name=f"camera-{camera_id}",
        camera_identity=f"camera:{camera_id}",
        recordings_root=recordings_root,
        runtime_dir=runtime_dir,
        segment_seconds=segment_seconds,
        reconnect_seconds=float(
            args.reconnect_seconds
            or os.getenv("CCTV_RECORDER_RECONNECT_SECONDS", "5")
        ),
        wait_for_camera_seconds=int(
            args.wait_seconds
            or os.getenv("CCTV_RECORDER_WAIT_FOR_CAMERA_SECONDS", "45")
        ),
        no_frame_timeout_seconds=int(
            args.no_frame_timeout
            or os.getenv("CCTV_RECORDER_NO_FRAME_TIMEOUT_SECONDS", "15")
        ),
        minimum_segment_seconds=float(
            args.minimum_segment_seconds
            or os.getenv("CCTV_RECORDER_MINIMUM_SEGMENT_SECONDS", "5")
        ),
        fps_hint=float(
            args.fps or os.getenv("CCTV_RECORDER_FPS", "10")
        ),
        crf=int(args.crf or os.getenv("CCTV_RECORDER_CRF", "27")),
        output_width=width,
        output_height=height,
        display_mode=display_mode,
        fit_mode=fit_mode,
        max_segments=max_segments,
    )


async def async_main(args: argparse.Namespace) -> int:
    if args.self_test:
        return await synthetic_self_test()

    project_root = Path(__file__).resolve().parents[1]
    config = build_config(args, project_root)
    config.recordings_root.mkdir(parents=True, exist_ok=True, mode=0o750)
    config.runtime_dir.mkdir(parents=True, exist_ok=True, mode=0o750)

    recorder = ContinuousRecorder(config)
    loop = asyncio.get_running_loop()

    for signal_name in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(signal_name, recorder.request_stop)

    lock_path = config.runtime_dir / "continuous_recorder.lock"
    pid_path = config.runtime_dir / "continuous_recorder.pid"

    with ProcessLock(lock_path, pid_path):
        await recorder.run()

    return 0


def main() -> int:
    args = parse_args()
    project_root = Path(__file__).resolve().parents[1]
    env_path = Path(
        args.env_file or project_root / ".env"
    ).expanduser().resolve()

    if not args.self_test:
        if not env_path.is_file():
            print(f"Environment file not found: {env_path}", file=sys.stderr)
            return 2
        load_dotenv(env_path, override=False)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    try:
        return asyncio.run(async_main(args))
    except KeyboardInterrupt:
        LOG.warning("Recorder interrupted by the user.")
        return 130
    except Exception as error:
        LOG.exception("Continuous recorder failed: %s", error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

