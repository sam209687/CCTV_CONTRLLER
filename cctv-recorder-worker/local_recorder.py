#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import shutil
import sys
import uuid
from datetime import datetime
from fractions import Fraction
from pathlib import Path

from dotenv import load_dotenv
from livekit import api, rtc
from PIL import Image, ImageOps

LOG = logging.getLogger("cctv-recorder")


def clean_camera_id(value: str) -> str:
    value = re.sub(r"[^a-z0-9._-]", "_", value.strip().lower())[:120]
    if not value:
        raise ValueError("Camera ID is required")
    return value


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def file_time(value: datetime) -> str:
    return value.strftime("%Y-%m-%d_%H-%M-%S")


def rotation_filter(value: int) -> str | None:
    return {
        1: "transpose=clock",
        2: "hflip,vflip",
        3: "transpose=cclock",
    }.get(value)


def normalize_rgb_frame(
    frame,
    rotation: int,
    output_width: int,
    output_height: int,
    fit_mode: str,
) -> bytes:
    source_width = int(frame.width)
    source_height = int(frame.height)
    raw = bytes(frame.data)
    expected = source_width * source_height * 3

    if len(raw) != expected:
        raise RuntimeError(
            f"Unexpected RGB24 size: {len(raw)} bytes; "
            f"expected {expected} for "
            f"{source_width}x{source_height}"
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
        raise ValueError(
            "Fit mode must be contain or cover."
        )

    image = ImageOps.contain(
        image,
        (output_width, output_height),
        method=Image.Resampling.BILINEAR,
    )

    if image.size == (output_width, output_height):
        return image.tobytes()

    canvas = Image.new(
        "RGB",
        (output_width, output_height),
        "black",
    )
    canvas.paste(
        image,
        (
            (output_width - image.width) // 2,
            (output_height - image.height) // 2,
        ),
    )
    return canvas.tobytes()


def fps_number(value: str | None) -> float | None:
    if not value or value == "0/0":
        return None
    try:
        return float(Fraction(value))
    except (ValueError, ZeroDivisionError):
        return None


async def probe_video(path: Path) -> dict:
    process = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries",
        "format=duration,size,start_time:"
        "stream=codec_name,width,height,avg_frame_rate,start_time",
        "-of", "json", str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode:
        raise RuntimeError(
            "ffprobe failed: " + stderr.decode(errors="replace").strip()
        )
    data = json.loads(stdout)
    stream = (data.get("streams") or [{}])[0]
    fmt = data.get("format") or {}
    result = {
        "codec": stream.get("codec_name"),
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "averageFps": fps_number(stream.get("avg_frame_rate")),
        "startTimeSeconds": float(
            stream.get("start_time")
            or fmt.get("start_time")
            or 0
        ),
        "durationSeconds": float(fmt.get("duration") or 0),
        "sizeBytes": int(fmt.get("size") or path.stat().st_size),
    }
    if result["codec"] != "h264":
        raise RuntimeError(f"Expected H.264, received {result['codec']}")
    if not -0.1 <= result["startTimeSeconds"] <= 1.0:
        raise RuntimeError(
            "Recording timestamps do not begin near zero: "
            f"{result['startTimeSeconds']:.3f}s"
        )
    if result["durationSeconds"] < 5:
        raise RuntimeError(
            f"Recording is too short: {result['durationSeconds']:.2f}s"
        )
    if result["sizeBytes"] < 100_000:
        raise RuntimeError(
            f"Recording is too small: {result['sizeBytes']} bytes"
        )
    return result


async def close_ffmpeg(process: asyncio.subprocess.Process) -> int:
    if process.stdin:
        try:
            process.stdin.close()
            await process.stdin.wait_closed()
        except (BrokenPipeError, ConnectionResetError):
            pass
    try:
        return await asyncio.wait_for(process.wait(), timeout=30)
    except asyncio.TimeoutError:
        process.terminate()
        try:
            return await asyncio.wait_for(process.wait(), timeout=10)
        except asyncio.TimeoutError:
            process.kill()
            return await process.wait()


async def record(args: argparse.Namespace) -> dict:
    camera_id = clean_camera_id(
        args.camera_id
        or os.getenv("CCTV_RECORDER_CAMERA_ID", "cam-1772515015057")
    )
    seconds = args.seconds or int(
        os.getenv("CCTV_RECORDER_TEST_SECONDS", "60")
    )
    fps = args.fps or float(os.getenv("CCTV_RECORDER_FPS", "10"))
    crf = args.crf or int(os.getenv("CCTV_RECORDER_CRF", "27"))
    wait_seconds = args.wait_seconds or int(
        os.getenv("CCTV_RECORDER_WAIT_FOR_CAMERA_SECONDS", "45")
    )
    recordings_root = Path(
        args.recordings_dir
        or os.getenv("CCTV_RECORDINGS_DIR", str(Path.home() / "CCTV_Recordings"))
    ).expanduser().resolve()

    if not 10 <= seconds <= 600:
        raise ValueError("Seconds must be between 10 and 600")
    if not 1 <= fps <= 60:
        raise ValueError("FPS must be between 1 and 60")
    if not 18 <= crf <= 40:
        raise ValueError("CRF must be between 18 and 40")

    livekit_url = required("LIVEKIT_URL")
    api_key = required("LIVEKIT_API_KEY")
    api_secret = required("LIVEKIT_API_SECRET")
    room_name = f"camera-{camera_id}"
    camera_identity = f"camera:{camera_id}"
    recorder_identity = f"recorder:{camera_id}:{uuid.uuid4().hex[:10]}"

    token = (
        api.AccessToken(api_key, api_secret)
        .with_identity(recorder_identity)
        .with_name(f"Local recorder {camera_id}")
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=False,
                can_subscribe=True,
                can_publish_data=False,
                hidden=True,
            )
        )
        .to_jwt()
    )

    room = rtc.Room()
    track_queue: asyncio.Queue = asyncio.Queue(maxsize=1)

    @room.on("track_subscribed")
    def on_track_subscribed(track, publication, participant):
        if (
            participant.identity == camera_identity
            and track.kind == rtc.TrackKind.KIND_VIDEO
            and track_queue.empty()
        ):
            if getattr(publication, "simulcasted", False):
                try:
                    publication.set_video_quality(
                        rtc.VideoQuality.VIDEO_QUALITY_HIGH
                    )
                    LOG.info(
                        "Requested LiveKit HIGH simulcast layer "
                        "for track %s",
                        publication.sid,
                    )
                except Exception:
                    LOG.exception(
                        "Could not request the HIGH simulcast layer; "
                        "startup stabilization will still be used."
                    )

            track_queue.put_nowait((track, publication))

    LOG.info("Connecting to LiveKit room %s", room_name)
    LOG.info("Waiting for %s", camera_identity)
    await room.connect(
        livekit_url,
        token,
        rtc.RoomOptions(auto_subscribe=True),
    )

    stream = None
    process = None
    log_handle = None
    partial = None

    try:
        try:
            track, publication = await asyncio.wait_for(
                track_queue.get(), timeout=wait_seconds
            )
        except asyncio.TimeoutError as exc:
            raise RuntimeError(
                f"No camera video track arrived in {wait_seconds}s. "
                "Confirm the phone shows WEBRTC LIVE."
            ) from exc

        stream = rtc.VideoStream(
            track,
            capacity=3,
            format=rtc.VideoBufferType.RGB24,
        )

        try:
            first_event = await asyncio.wait_for(
                stream.__anext__(),
                timeout=10,
            )
        except asyncio.TimeoutError as exc:
            raise RuntimeError(
                "Camera track produced no frame for 10s"
            ) from exc
        except StopAsyncIteration as exc:
            raise RuntimeError(
                "Camera track ended before recording started"
            ) from exc

        display_mode = str(
            args.display_mode
            or os.getenv(
                "CCTV_RECORDER_DISPLAY_MODE",
                "portrait",
            )
        ).strip().lower()

        fit_mode = str(
            args.fit_mode
            or os.getenv(
                "CCTV_RECORDER_FIT_MODE",
                "contain",
            )
        ).strip().lower()

        if display_mode == "portrait":
            output_width = int(
                os.getenv(
                    "CCTV_RECORDER_PORTRAIT_WIDTH",
                    "720",
                )
            )
            output_height = int(
                os.getenv(
                    "CCTV_RECORDER_PORTRAIT_HEIGHT",
                    "1280",
                )
            )
        elif display_mode == "landscape":
            output_width = int(
                os.getenv(
                    "CCTV_RECORDER_LANDSCAPE_WIDTH",
                    "1280",
                )
            )
            output_height = int(
                os.getenv(
                    "CCTV_RECORDER_LANDSCAPE_HEIGHT",
                    "720",
                )
            )
        elif display_mode == "custom":
            output_width = int(
                os.getenv(
                    "CCTV_RECORDER_OUTPUT_WIDTH",
                    "720",
                )
            )
            output_height = int(
                os.getenv(
                    "CCTV_RECORDER_OUTPUT_HEIGHT",
                    "1280",
                )
            )
        else:
            raise ValueError(
                "Display mode must be portrait, landscape, or custom."
            )

        if fit_mode not in {"contain", "cover"}:
            raise ValueError(
                "Fit mode must be contain or cover."
            )

        output_width -= output_width % 2
        output_height -= output_height % 2

        if output_width < 2 or output_height < 2:
            raise ValueError(
                "Recorder output dimensions must be positive even numbers"
            )

        width = output_width
        height = output_height
        rotation = 0

        LOG.info(
            "Recorder canvas: %sx%s mode=%s fit=%s",
            width,
            height,
            display_mode,
            fit_mode,
        )
        started = datetime.now().astimezone()
        target_dir = (
            recordings_root
            / camera_id
            / started.strftime("%Y")
            / started.strftime("%m")
            / started.strftime("%d")
        )
        target_dir.mkdir(parents=True, exist_ok=True, mode=0o750)
        stem = f"{camera_id}_{file_time(started)}"
        partial = target_dir / f"{stem}.partial.mp4"
        ffmpeg_log = target_dir / f"{stem}.ffmpeg.log"
        log_handle = ffmpeg_log.open("wb")

        command = [
            "ffmpeg", "-hide_banner", "-loglevel", "warning", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-video_size", f"{width}x{height}",
            "-framerate", f"{fps:g}",
            "-use_wallclock_as_timestamps", "1",
            "-i", "pipe:0", "-an",
            "-vf", "setpts=PTS-STARTPTS",
            "-fps_mode", "vfr",
            "-avoid_negative_ts", "make_zero",
        ]
        command += [
            "-c:v", "libx264", "-preset", "veryfast",
            "-tune", "zerolatency", "-crf", str(crf),
            "-maxrate", "1500k", "-bufsize", "3000k",
            "-pix_fmt", "yuv420p",
            "-video_track_timescale", "90000",
            "-movflags", "+faststart",
            str(partial),
        ]

        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=log_handle,
        )
        if process.stdin is None:
            raise RuntimeError("FFmpeg stdin was not created")

        deadline = asyncio.get_running_loop().time() + seconds
        frame_count = 0
        first_timestamp_us = int(first_event.timestamp_us)
        last_timestamp_us = first_timestamp_us

        source_resolution_counts = {}
        source_rotation_counts = {}
        last_source_signature = None

        async def write_event(event) -> None:
            nonlocal frame_count
            nonlocal last_timestamp_us
            nonlocal last_source_signature

            current = event.frame
            source_width = int(current.width)
            source_height = int(current.height)
            source_rotation = int(event.rotation)
            signature = (
                source_width,
                source_height,
                source_rotation,
            )

            resolution_key = f"{source_width}x{source_height}"
            rotation_key = str(source_rotation)

            source_resolution_counts[resolution_key] = (
                source_resolution_counts.get(resolution_key, 0) + 1
            )
            source_rotation_counts[rotation_key] = (
                source_rotation_counts.get(rotation_key, 0) + 1
            )

            if signature != last_source_signature:
                LOG.info(
                    "Input layer %sx%s rotation=%s "
                    "normalized to %sx%s",
                    source_width,
                    source_height,
                    source_rotation,
                    width,
                    height,
                )
                last_source_signature = signature

            normalized = normalize_rgb_frame(
                current,
                source_rotation,
                width,
                height,
                fit_mode,
            )

            try:
                process.stdin.write(normalized)
                await process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as exc:
                raise RuntimeError(
                    "FFmpeg stopped accepting normalized frames"
                ) from exc

            frame_count += 1
            last_timestamp_us = int(event.timestamp_us)
        await write_event(first_event)
        LOG.info(
            "Recording %ss: %sx%s, %.2f FPS, mode=%s, fit=%s",
            seconds,
            width,
            height,
            fps,
            display_mode,
            fit_mode,
        )

        while asyncio.get_running_loop().time() < deadline:
            remaining = deadline - asyncio.get_running_loop().time()
            try:
                event = await asyncio.wait_for(
                    stream.__anext__(),
                    timeout=min(10.0, max(0.1, remaining)),
                )
            except asyncio.TimeoutError:
                if asyncio.get_running_loop().time() >= deadline:
                    break
                raise RuntimeError("No video frame received for 10s")
            except StopAsyncIteration as exc:
                raise RuntimeError("Camera video track ended early") from exc
            await write_event(event)
            if frame_count % max(1, round(fps * 10)) == 0:
                LOG.info("Received %s frames", frame_count)

        return_code = await close_ffmpeg(process)
        process = None
        log_handle.close()
        log_handle = None
        if return_code:
            raise RuntimeError(
                f"FFmpeg exited with {return_code}; read {ffmpeg_log}"
            )

        inspection = await probe_video(partial)
        minimum_acceptable_duration = max(
            5.0,
            seconds * 0.85,
        )
        if (
            inspection["durationSeconds"]
            < minimum_acceptable_duration
        ):
            raise RuntimeError(
                "Recorded timeline is too short: "
                f'{inspection["durationSeconds"]:.2f}s; '
                f"expected at least "
                f"{minimum_acceptable_duration:.2f}s."
            )
        ended = datetime.now().astimezone()
        final = target_dir / (
            f"{camera_id}_{file_time(started)}"
            f"_to_{ended.strftime('%H-%M-%S')}.mp4"
        )
        partial.replace(final)
        final_log = final.with_suffix(".ffmpeg.log")
        ffmpeg_log.replace(final_log)
        metadata_path = final.with_suffix(".json")
        metadata = {
            "schemaVersion": 1,
            "phase": "11I-L1E",
            "recordingMode": "LOCAL_PROOF_CLEAN_TIMESTAMPS",
            "cameraId": camera_id,
            "roomName": room_name,
            "cameraIdentity": camera_identity,
            "recorderIdentity": recorder_identity,
            "trackSid": publication.sid,
            "startedAt": started.isoformat(),
            "endedAt": ended.isoformat(),
            "requestedDurationSeconds": seconds,
            "frameCount": frame_count,
            "outputWidth": width,
            "outputHeight": height,
            "displayMode": display_mode,
            "fitMode": fit_mode,
            "timestampMode": "wallclock-reset-start",
            "sourceResolutionCounts": source_resolution_counts,
            "sourceRotationCounts": source_rotation_counts,
            "firstTimestampUs": first_timestamp_us,
            "lastTimestampUs": last_timestamp_us,
            "filePath": str(final),
            "ffmpegLogPath": str(final_log),
            **inspection,
        }
        metadata_path.write_text(
            json.dumps(metadata, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return metadata
    finally:
        if stream is not None:
            try:
                await stream.aclose()
            except Exception:
                pass
        if process is not None:
            try:
                await close_ffmpeg(process)
            except Exception:
                pass
        if log_handle is not None:
            log_handle.close()
        await room.disconnect()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file")
    parser.add_argument("--camera-id")
    parser.add_argument("--seconds", type=int)
    parser.add_argument("--fps", type=float)
    parser.add_argument("--crf", type=int)
    parser.add_argument("--wait-seconds", type=int)
    parser.add_argument("--recordings-dir")
    parser.add_argument(
        "--display-mode",
        choices=("portrait", "landscape", "custom"),
    )
    parser.add_argument(
        "--fit-mode",
        choices=("contain", "cover"),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    default_env = Path(__file__).resolve().parents[1] / ".env"
    env_file = Path(args.env_file or default_env).expanduser().resolve()
    if not env_file.is_file():
        print(f"Missing environment file: {env_file}", file=sys.stderr)
        return 2
    load_dotenv(env_file, override=False)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        result = asyncio.run(record(args))
    except KeyboardInterrupt:
        LOG.warning("Recording interrupted")
        return 130
    except Exception as exc:
        LOG.exception("Local recording failed: %s", exc)
        return 1

    print(json.dumps({"ok": True, "recording": result}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
