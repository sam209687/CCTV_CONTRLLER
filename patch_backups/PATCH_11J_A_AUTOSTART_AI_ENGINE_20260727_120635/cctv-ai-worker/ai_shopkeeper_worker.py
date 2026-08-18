#!/usr/bin/env python3
"""Premium AI Smart Shopkeeper edge worker.

This worker subscribes to a LiveKit smartphone camera, performs
local CPU person and face-presence detection, assigns people to
customer/staff zones, and reports detection state to the CCTV backend.

It performs face detection only. It does not identify a person.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import fcntl
import json
import logging
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from dotenv import load_dotenv
from livekit import api, rtc


LOG = logging.getLogger(
    "cctv-ai-shopkeeper"
)


def iso_now() -> str:
    return (
        datetime.now()
        .astimezone()
        .isoformat()
    )


def safe_camera_id(value: str) -> str:
    value = re.sub(
        r"[^a-zA-Z0-9._-]",
        "_",
        str(value or "").strip(),
    )[:120]

    if not value:
        raise ValueError(
            "Camera ID is required"
        )

    return value


def required_environment(
    name: str,
) -> str:
    value = str(
        os.getenv(name, "")
    ).strip()

    if not value:
        raise RuntimeError(
            f"Missing environment variable: {name}"
        )

    return value


def parse_zone(
    value: str,
    name: str,
) -> tuple[float, float, float, float]:
    parts = [
        float(item.strip())
        for item in value.split(",")
    ]

    if len(parts) != 4:
        raise ValueError(
            f"{name} must contain x1,y1,x2,y2"
        )

    x1, y1, x2, y2 = parts

    if not (
        0 <= x1 < x2 <= 1
        and 0 <= y1 < y2 <= 1
    ):
        raise ValueError(
            f"{name} coordinates must be between 0 and 1"
        )

    return x1, y1, x2, y2


def point_in_zone(
    x: float,
    y: float,
    zone: tuple[
        float,
        float,
        float,
        float,
    ],
) -> bool:
    x1, y1, x2, y2 = zone

    return (
        x1 <= x <= x2
        and y1 <= y <= y2
    )


def rotate_rgb(
    image: np.ndarray,
    rotation: int,
) -> np.ndarray:
    if rotation == 1:
        return cv2.rotate(
            image,
            cv2.ROTATE_90_CLOCKWISE,
        )

    if rotation == 2:
        return cv2.rotate(
            image,
            cv2.ROTATE_180,
        )

    if rotation == 3:
        return cv2.rotate(
            image,
            cv2.ROTATE_90_COUNTERCLOCKWISE,
        )

    return image


def encode_zone(
    zone: tuple[
        float,
        float,
        float,
        float,
    ],
) -> list[float]:
    return [
        round(value, 4)
        for value in zone
    ]


@dataclass(frozen=True)
class WorkerConfig:
    camera_id: str
    room_name: str
    camera_identity: str
    backend_url: str
    dashboard_token: str
    customer_zone: tuple[
        float,
        float,
        float,
        float,
    ]
    staff_zone: tuple[
        float,
        float,
        float,
        float,
    ]
    sample_interval_seconds: float
    reconnect_seconds: float
    wait_for_camera_seconds: float
    frame_timeout_seconds: float
    detection_width: int
    jpeg_quality: int
    minimum_weight: float
    minimum_box_area_ratio: float
    face_detection_enabled: bool
    runtime_dir: Path


class AtomicStatus:
    def __init__(
        self,
        path: Path,
        config: WorkerConfig,
    ) -> None:
        self.path = path
        self.base = {
            "schemaVersion": 1,
            "phase": "11J-A",
            "cameraId":
                config.camera_id,
            "roomName":
                config.room_name,
            "customerZone":
                encode_zone(
                    config.customer_zone
                ),
            "staffZone":
                encode_zone(
                    config.staff_zone
                ),
            "pid": os.getpid(),
            "startedAt": iso_now(),
        }

    def update(
        self,
        state: str,
        **values: Any,
    ) -> None:
        payload = {
            **self.base,
            "state": state,
            "updatedAt": iso_now(),
            **values,
        }

        self.path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        temporary = self.path.with_name(
            f".{self.path.name}.tmp-"
            f"{os.getpid()}-"
            f"{uuid.uuid4().hex[:8]}"
        )

        temporary.write_text(
            json.dumps(
                payload,
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )

        temporary.replace(self.path)


class ProcessLock:
    def __init__(
        self,
        lock_path: Path,
        pid_path: Path,
    ) -> None:
        self.lock_path = lock_path
        self.pid_path = pid_path
        self.handle: Any | None = None

    def __enter__(
        self,
    ) -> "ProcessLock":
        self.lock_path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        self.handle = self.lock_path.open(
            "a+",
            encoding="utf-8",
        )

        try:
            fcntl.flock(
                self.handle.fileno(),
                fcntl.LOCK_EX |
                fcntl.LOCK_NB,
            )
        except BlockingIOError as error:
            raise RuntimeError(
                "Another AI worker already owns "
                f"{self.lock_path}"
            ) from error

        self.handle.seek(0)
        self.handle.truncate()
        self.handle.write(
            f"{os.getpid()}\n"
        )
        self.handle.flush()

        self.pid_path.write_text(
            f"{os.getpid()}\n",
            encoding="utf-8",
        )

        return self

    def __exit__(
        self,
        *_: Any,
    ) -> None:
        with contextlib.suppress(
            FileNotFoundError
        ):
            self.pid_path.unlink()

        if self.handle is not None:
            with contextlib.suppress(
                OSError
            ):
                fcntl.flock(
                    self.handle.fileno(),
                    fcntl.LOCK_UN,
                )

            self.handle.close()
            self.handle = None


class LocalDetector:
    def __init__(
        self,
        config: WorkerConfig,
    ) -> None:
        self.config = config

        self.hog = cv2.HOGDescriptor()

        try:
            people_detector = (
                cv2
                .HOGDescriptor_getDefaultPeopleDetector()
            )
        except AttributeError:
            people_detector = (
                cv2.HOGDescriptor
                .getDefaultPeopleDetector()
            )

        self.hog.setSVMDetector(
            people_detector
        )

        cascade_path = (
            Path(cv2.data.haarcascades)
            / "haarcascade_frontalface_default.xml"
        )

        self.face_detector = (
            cv2.CascadeClassifier(
                str(cascade_path)
            )
        )

        if (
            config.face_detection_enabled
            and self.face_detector.empty()
        ):
            raise RuntimeError(
                "OpenCV face cascade could not be loaded"
            )

    def prepare_frame(
        self,
        frame: rtc.VideoFrame,
        rotation: int,
    ) -> np.ndarray:
        width = int(frame.width)
        height = int(frame.height)

        raw = np.frombuffer(
            bytes(frame.data),
            dtype=np.uint8,
        )

        expected = width * height * 3

        if raw.size != expected:
            raise RuntimeError(
                "Unexpected RGB24 frame size: "
                f"{raw.size}; expected {expected}"
            )

        rgb = raw.reshape(
            height,
            width,
            3,
        )

        rgb = rotate_rgb(
            rgb,
            rotation,
        )

        source_height, source_width = (
            rgb.shape[:2]
        )

        target_width = min(
            self.config.detection_width,
            source_width,
        )

        scale = (
            target_width /
            source_width
        )

        target_height = max(
            128,
            round(
                source_height * scale
            ),
        )

        return cv2.resize(
            rgb,
            (
                target_width,
                target_height,
            ),
            interpolation=cv2.INTER_AREA,
        )

    def person_boxes(
        self,
        bgr: np.ndarray,
    ) -> list[dict[str, Any]]:
        rectangles, weights = (
            self.hog.detectMultiScale(
                bgr,
                0,
                (8, 8),
                (8, 8),
                1.05,
                2,
                False,
            )
        )

        frame_height, frame_width = (
            bgr.shape[:2]
        )

        frame_area = (
            frame_width * frame_height
        )

        boxes: list[list[int]] = []
        scores: list[float] = []

        for rectangle, raw_weight in zip(
            rectangles,
            weights,
        ):
            x, y, width, height = [
                int(value)
                for value in rectangle
            ]

            weight = float(
                np.asarray(
                    raw_weight
                ).reshape(-1)[0]
            )

            area_ratio = (
                width * height
            ) / max(1, frame_area)

            if (
                weight <
                self.config.minimum_weight
                or area_ratio <
                self.config
                .minimum_box_area_ratio
            ):
                continue

            boxes.append(
                [x, y, width, height]
            )

            scores.append(weight)

        if not boxes:
            return []

        score_threshold = max(
            0.0,
            min(
                self.config.minimum_weight,
                max(scores),
            ),
        )

        indexes = cv2.dnn.NMSBoxes(
            boxes,
            scores,
            score_threshold,
            0.4,
        )

        if indexes is None:
            return []

        flattened = np.asarray(
            indexes
        ).reshape(-1)

        results: list[
            dict[str, Any]
        ] = []

        for raw_index in flattened:
            index = int(raw_index)

            if not (
                0 <= index < len(boxes)
            ):
                continue

            x, y, width, height = (
                boxes[index]
            )

            centre_x = (
                x + width / 2
            ) / frame_width

            centre_y = (
                y + height / 2
            ) / frame_height

            zone = "outside"

            if point_in_zone(
                centre_x,
                centre_y,
                self.config.staff_zone,
            ):
                zone = "staff"
            elif point_in_zone(
                centre_x,
                centre_y,
                self.config.customer_zone,
            ):
                zone = "customer"

            results.append({
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "confidence":
                    round(
                        scores[index],
                        4,
                    ),
                "centreX":
                    round(
                        centre_x,
                        4,
                    ),
                "centreY":
                    round(
                        centre_y,
                        4,
                    ),
                "zone": zone,
            })

        return results

    def face_boxes(
        self,
        bgr: np.ndarray,
    ) -> list[dict[str, int]]:
        if not (
            self.config
            .face_detection_enabled
        ):
            return []

        gray = cv2.cvtColor(
            bgr,
            cv2.COLOR_BGR2GRAY,
        )

        gray = cv2.equalizeHist(gray)

        faces = (
            self.face_detector
            .detectMultiScale(
                gray,
                scaleFactor=1.1,
                minNeighbors=5,
                minSize=(24, 24),
            )
        )

        return [
            {
                "x": int(x),
                "y": int(y),
                "width": int(width),
                "height": int(height),
            }
            for x, y, width, height
            in faces
        ]

    def draw_zone(
        self,
        image: np.ndarray,
        zone: tuple[
            float,
            float,
            float,
            float,
        ],
        label: str,
        colour: tuple[
            int,
            int,
            int,
        ],
    ) -> None:
        height, width = image.shape[:2]

        x1 = round(zone[0] * width)
        y1 = round(zone[1] * height)
        x2 = round(zone[2] * width)
        y2 = round(zone[3] * height)

        cv2.rectangle(
            image,
            (x1, y1),
            (x2, y2),
            colour,
            2,
        )

        cv2.putText(
            image,
            label,
            (
                x1 + 5,
                max(18, y1 + 18),
            ),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            colour,
            1,
            cv2.LINE_AA,
        )

    def analyse(
        self,
        frame: rtc.VideoFrame,
        rotation: int,
    ) -> dict[str, Any]:
        started = time.monotonic()

        rgb = self.prepare_frame(
            frame,
            rotation,
        )

        bgr = cv2.cvtColor(
            rgb,
            cv2.COLOR_RGB2BGR,
        )

        people = self.person_boxes(bgr)
        faces = self.face_boxes(bgr)

        customer_count = sum(
            1
            for item in people
            if item["zone"] ==
            "customer"
        )

        staff_count = sum(
            1
            for item in people
            if item["zone"] ==
            "staff"
        )

        annotated = bgr.copy()

        self.draw_zone(
            annotated,
            self.config.customer_zone,
            "CUSTOMER",
            (0, 200, 255),
        )

        self.draw_zone(
            annotated,
            self.config.staff_zone,
            "STAFF",
            (80, 255, 80),
        )

        for person in people:
            x = person["x"]
            y = person["y"]
            width = person["width"]
            height = person["height"]

            colour = (
                (80, 255, 80)
                if person["zone"] ==
                "staff"
                else (0, 200, 255)
            )

            cv2.rectangle(
                annotated,
                (x, y),
                (
                    x + width,
                    y + height,
                ),
                colour,
                2,
            )

            cv2.putText(
                annotated,
                (
                    f"person "
                    f"{person['zone']}"
                ),
                (
                    x,
                    max(16, y - 5),
                ),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.45,
                colour,
                1,
                cv2.LINE_AA,
            )

        for face in faces:
            x = face["x"]
            y = face["y"]
            width = face["width"]
            height = face["height"]

            cv2.rectangle(
                annotated,
                (x, y),
                (
                    x + width,
                    y + height,
                ),
                (255, 140, 0),
                2,
            )

        encoded_ok, encoded = (
            cv2.imencode(
                ".jpg",
                annotated,
                [
                    int(
                        cv2.IMWRITE_JPEG_QUALITY
                    ),
                    self.config.jpeg_quality,
                ],
            )
        )

        image_base64 = (
            base64.b64encode(
                encoded.tobytes()
            ).decode("ascii")
            if encoded_ok
            else None
        )

        confidences = [
            item["confidence"]
            for item in people
        ]

        confidence = (
            max(confidences)
            if confidences
            else 0.0
        )

        return {
            "customerCount":
                customer_count,
            "staffCount":
                staff_count,
            "faceCount": len(faces),
            "confidence":
                min(
                    1.0,
                    max(
                        0.0,
                        confidence,
                    ),
                ),
            "boxes": people,
            "faces": faces,
            "customerZone":
                encode_zone(
                    self.config
                    .customer_zone
                ),
            "staffZone":
                encode_zone(
                    self.config
                    .staff_zone
                ),
            "imageJpegBase64":
                image_base64,
            "processingMilliseconds":
                round(
                    (
                        time.monotonic() -
                        started
                    ) * 1000,
                    1,
                ),
        }


def post_json(
    url: str,
    token: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(
            payload,
            separators=(",", ":"),
        ).encode("utf-8"),
        headers={
            "Authorization":
                f"Bearer {token}",
            "Content-Type":
                "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(
            request,
            timeout=15,
        ) as response:
            body = response.read()

            return (
                json.loads(
                    body.decode("utf-8")
                )
                if body
                else {}
            )
    except urllib.error.HTTPError as error:
        body = error.read().decode(
            "utf-8",
            errors="replace",
        )

        raise RuntimeError(
            f"Backend HTTP {error.code}: "
            f"{body}"
        ) from error


class AiShopkeeperWorker:
    def __init__(
        self,
        config: WorkerConfig,
    ) -> None:
        self.config = config
        self.detector = LocalDetector(
            config
        )
        self.stop_event = asyncio.Event()
        self.reconnect_count = 0
        self.worker_id = (
            f"ai:{config.camera_id}:"
            f"{uuid.uuid4().hex[:12]}"
        )

        self.status = AtomicStatus(
            config.runtime_dir
            / "ai_shopkeeper_status.json",
            config,
        )

    def request_stop(self) -> None:
        self.stop_event.set()

    def create_token(self) -> str:
        api_key = required_environment(
            "LIVEKIT_API_KEY"
        )

        api_secret = required_environment(
            "LIVEKIT_API_SECRET"
        )

        return (
            api.AccessToken(
                api_key,
                api_secret,
            )
            .with_identity(
                self.worker_id
            )
            .with_name(
                "AI Smart Shopkeeper "
                f"{self.config.camera_id}"
            )
            .with_metadata(
                json.dumps({
                    "role":
                        "ai-smart-shopkeeper",
                    "cameraId":
                        self.config.camera_id,
                    "phase": "11J-A",
                })
            )
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=
                        self.config.room_name,
                    can_publish=False,
                    can_subscribe=True,
                    can_publish_data=False,
                    hidden=True,
                )
            )
            .to_jwt()
        )

    async def sleep_or_stop(
        self,
        seconds: float,
    ) -> None:
        try:
            await asyncio.wait_for(
                self.stop_event.wait(),
                timeout=seconds,
            )
        except asyncio.TimeoutError:
            pass

    async def run_forever(self) -> None:
        self.status.update(
            "STARTING",
            reconnectCount=0,
        )

        while not self.stop_event.is_set():
            try:
                await self.run_session()
            except Exception as error:
                if self.stop_event.is_set():
                    break

                self.reconnect_count += 1

                LOG.exception(
                    "AI session failed: %s",
                    error,
                )

                self.status.update(
                    "ERROR_RETRYING",
                    reconnectCount=
                        self.reconnect_count,
                    lastError=str(error),
                    retryInSeconds=
                        self.config
                        .reconnect_seconds,
                )

                await self.sleep_or_stop(
                    self.config
                    .reconnect_seconds
                )

        self.status.update(
            "STOPPED",
            reconnectCount=
                self.reconnect_count,
            stoppedAt=iso_now(),
        )

    async def run_session(self) -> None:
        room = rtc.Room()

        track_queue: asyncio.Queue[
            tuple[Any, Any]
        ] = asyncio.Queue(
            maxsize=1
        )

        session_lost = asyncio.Event()

        loss_reason = {
            "value":
                "camera-session-ended"
        }

        @room.on("track_subscribed")
        def on_track_subscribed(
            track,
            publication,
            participant,
        ) -> None:
            if (
                participant.identity ==
                self.config
                .camera_identity
                and track.kind ==
                rtc.TrackKind.KIND_VIDEO
                and track_queue.empty()
            ):
                if getattr(
                    publication,
                    "simulcasted",
                    False,
                ):
                    with contextlib.suppress(
                        Exception
                    ):
                        publication.set_video_quality(
                            rtc.VideoQuality
                            .VIDEO_QUALITY_MEDIUM
                        )

                track_queue.put_nowait(
                    (
                        track,
                        publication,
                    )
                )

        @room.on("track_unsubscribed")
        def on_track_unsubscribed(
            track,
            _publication,
            participant,
        ) -> None:
            if (
                participant.identity ==
                self.config
                .camera_identity
                and track.kind ==
                rtc.TrackKind.KIND_VIDEO
            ):
                loss_reason["value"] = (
                    "camera-track-unsubscribed"
                )

                session_lost.set()

        @room.on("participant_disconnected")
        def on_participant_disconnected(
            participant,
        ) -> None:
            if (
                participant.identity ==
                self.config
                .camera_identity
            ):
                loss_reason["value"] = (
                    "camera-participant-disconnected"
                )

                session_lost.set()

        @room.on("disconnected")
        def on_disconnected(
            reason,
        ) -> None:
            loss_reason["value"] = (
                "ai-room-disconnected:"
                f"{reason}"
            )

            session_lost.set()

        livekit_url = (
            required_environment(
                "LIVEKIT_URL"
            )
        )

        self.status.update(
            "CONNECTING",
            reconnectCount=
                self.reconnect_count,
            livekitUrl=livekit_url,
        )

        await room.connect(
            livekit_url,
            self.create_token(),
            rtc.RoomOptions(
                auto_subscribe=True
            ),
        )

        stream: rtc.VideoStream | None = (
            None
        )

        try:
            self.status.update(
                "WAITING_TRACK",
                reconnectCount=
                    self.reconnect_count,
            )

            track_task = (
                asyncio.create_task(
                    track_queue.get()
                )
            )

            stop_task = (
                asyncio.create_task(
                    self.stop_event.wait()
                )
            )

            lost_task = (
                asyncio.create_task(
                    session_lost.wait()
                )
            )

            done, pending = (
                await asyncio.wait(
                    {
                        track_task,
                        stop_task,
                        lost_task,
                    },
                    timeout=
                        self.config
                        .wait_for_camera_seconds,
                    return_when=
                        asyncio
                        .FIRST_COMPLETED,
                )
            )

            for task in pending:
                task.cancel()

            await asyncio.gather(
                *pending,
                return_exceptions=True,
            )

            if not done:
                raise RuntimeError(
                    "Camera track did not "
                    "arrive before timeout"
                )

            if (
                stop_task in done
                and stop_task.result()
            ):
                return

            if (
                lost_task in done
                and lost_task.result()
            ):
                raise RuntimeError(
                    loss_reason["value"]
                )

            track, publication = (
                track_task.result()
            )

            stream = rtc.VideoStream(
                track,
                capacity=2,
                format=
                    rtc.VideoBufferType
                    .RGB24,
            )

            last_sample_at = 0.0

            self.status.update(
                "ANALYSING",
                reconnectCount=
                    self.reconnect_count,
                trackSid=publication.sid,
            )

            while not (
                self.stop_event.is_set()
                or session_lost.is_set()
            ):
                try:
                    event = (
                        await asyncio
                        .wait_for(
                            stream.__anext__(),
                            timeout=
                                self.config
                                .frame_timeout_seconds,
                        )
                    )
                except asyncio.TimeoutError:
                    raise RuntimeError(
                        "No camera frame arrived "
                        "before timeout"
                    )

                now = time.monotonic()

                if (
                    now - last_sample_at <
                    self.config
                    .sample_interval_seconds
                ):
                    continue

                last_sample_at = now

                result = (
                    self.detector.analyse(
                        event.frame,
                        int(
                            event.rotation
                        ),
                    )
                )

                payload = {
                    "cameraId":
                        self.config
                        .camera_id,
                    "timestamp":
                        iso_now(),
                    "workerId":
                        self.worker_id,
                    "detector":
                        (
                            "opencv-hog-person"
                            "+haar-face-presence"
                        ),
                    **result,
                }

                response = (
                    await asyncio.to_thread(
                        post_json,
                        (
                            self.config
                            .backend_url
                            + "/ai/detections"
                        ),
                        self.config
                        .dashboard_token,
                        payload,
                    )
                )

                state = (
                    response
                    .get("state", {})
                    .get("state", "UNKNOWN")
                )

                LOG.info(
                    "AI state=%s "
                    "customer=%s staff=%s "
                    "faces=%s processing=%sms",
                    state,
                    result[
                        "customerCount"
                    ],
                    result[
                        "staffCount"
                    ],
                    result[
                        "faceCount"
                    ],
                    result[
                        "processingMilliseconds"
                    ],
                )

                self.status.update(
                    "ANALYSING",
                    reconnectCount=
                        self.reconnect_count,
                    trackSid=publication.sid,
                    aiState=state,
                    customerCount=
                        result[
                            "customerCount"
                        ],
                    staffCount=
                        result[
                            "staffCount"
                        ],
                    faceCount=
                        result[
                            "faceCount"
                        ],
                    confidence=
                        result[
                            "confidence"
                        ],
                    processingMilliseconds=
                        result[
                            "processingMilliseconds"
                        ],
                    lastDetectionAt=
                        iso_now(),
                )

            if session_lost.is_set():
                raise RuntimeError(
                    loss_reason["value"]
                )
        finally:
            if stream is not None:
                with contextlib.suppress(
                    Exception
                ):
                    await stream.aclose()

            with contextlib.suppress(
                Exception
            ):
                await room.disconnect()


def build_config(
    args: argparse.Namespace,
    project_root: Path,
) -> WorkerConfig:
    camera_id = safe_camera_id(
        args.camera_id
        or os.getenv(
            "CCTV_AI_CAMERA_ID",
            os.getenv(
                "CCTV_RECORDER_CAMERA_ID",
                "cam-1772515015057",
            ),
        )
    )

    backend_url = str(
        os.getenv(
            "CCTV_AI_BACKEND_URL",
            "http://127.0.0.1:3000",
        )
    ).rstrip("/")

    dashboard_token = (
        required_environment(
            "CCTV_DASHBOARD_TOKEN"
        )
    )

    customer_zone = parse_zone(
        os.getenv(
            "CCTV_AI_CUSTOMER_ZONE",
            "0.00,0.00,0.65,1.00",
        ),
        "CCTV_AI_CUSTOMER_ZONE",
    )

    staff_zone = parse_zone(
        os.getenv(
            "CCTV_AI_STAFF_ZONE",
            "0.65,0.00,1.00,1.00",
        ),
        "CCTV_AI_STAFF_ZONE",
    )

    runtime_dir = Path(
        os.getenv(
            "CCTV_AI_RUNTIME_DIR",
            str(
                project_root /
                "runtime" /
                "cctv-ai"
            ),
        )
    ).expanduser().resolve()

    return WorkerConfig(
        camera_id=camera_id,
        room_name=
            f"camera-{camera_id}",
        camera_identity=
            f"camera:{camera_id}",
        backend_url=backend_url,
        dashboard_token=
            dashboard_token,
        customer_zone=
            customer_zone,
        staff_zone=staff_zone,
        sample_interval_seconds=
            max(
                0.5,
                float(
                    os.getenv(
                        "CCTV_AI_SAMPLE_INTERVAL_SECONDS",
                        "1.0",
                    )
                ),
            ),
        reconnect_seconds=
            max(
                1.0,
                float(
                    os.getenv(
                        "CCTV_AI_RECONNECT_SECONDS",
                        "5",
                    )
                ),
            ),
        wait_for_camera_seconds=
            max(
                10,
                float(
                    os.getenv(
                        "CCTV_AI_WAIT_FOR_CAMERA_SECONDS",
                        "45",
                    )
                ),
            ),
        frame_timeout_seconds=
            max(
                5,
                float(
                    os.getenv(
                        "CCTV_AI_FRAME_TIMEOUT_SECONDS",
                        "15",
                    )
                ),
            ),
        detection_width=
            max(
                256,
                min(
                    640,
                    int(
                        os.getenv(
                            "CCTV_AI_DETECTION_WIDTH",
                            "416",
                        )
                    ),
                ),
            ),
        jpeg_quality=
            max(
                40,
                min(
                    90,
                    int(
                        os.getenv(
                            "CCTV_AI_JPEG_QUALITY",
                            "72",
                        )
                    ),
                ),
            ),
        minimum_weight=
            float(
                os.getenv(
                    "CCTV_AI_MIN_PERSON_WEIGHT",
                    "0.15",
                )
            ),
        minimum_box_area_ratio=
            max(
                0.005,
                float(
                    os.getenv(
                        "CCTV_AI_MIN_BOX_AREA_RATIO",
                        "0.025",
                    )
                ),
            ),
        face_detection_enabled=
            str(
                os.getenv(
                    "CCTV_AI_FACE_DETECTION",
                    "true",
                )
            )
            .strip()
            .lower()
            not in {
                "0",
                "false",
                "no",
                "off",
            },
        runtime_dir=runtime_dir,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--env-file"
    )

    parser.add_argument(
        "--camera-id"
    )

    parser.add_argument(
        "--self-test",
        action="store_true",
    )

    return parser.parse_args()


def main() -> int:
    args = parse_args()

    project_root = (
        Path(__file__)
        .resolve()
        .parents[1]
    )

    env_file = Path(
        args.env_file
        or project_root / ".env"
    ).expanduser().resolve()

    if not env_file.is_file():
        print(
            f"Missing environment file: "
            f"{env_file}",
            file=sys.stderr,
        )
        return 2

    load_dotenv(
        env_file,
        override=False,
    )

    logging.basicConfig(
        level=logging.INFO,
        format=(
            "%(asctime)s "
            "%(levelname)s "
            "%(name)s: "
            "%(message)s"
        ),
    )

    config = build_config(
        args,
        project_root,
    )

    detector = LocalDetector(config)

    if args.self_test:
        blank = np.zeros(
            (
                360,
                640,
                3,
            ),
            dtype=np.uint8,
        )

        people = detector.person_boxes(
            blank
        )

        faces = detector.face_boxes(
            blank
        )

        print(
            json.dumps(
                {
                    "ok": True,
                    "phase": "11J-A",
                    "opencvVersion":
                        cv2.__version__,
                    "cameraId":
                        config.camera_id,
                    "customerZone":
                        encode_zone(
                            config
                            .customer_zone
                        ),
                    "staffZone":
                        encode_zone(
                            config
                            .staff_zone
                        ),
                    "blankPersonCount":
                        len(people),
                    "blankFaceCount":
                        len(faces),
                    "faceDetectionOnly":
                        True,
                    "faceRecognition":
                        False,
                },
                indent=2,
            )
        )

        return 0

    config.runtime_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    worker = AiShopkeeperWorker(
        config
    )

    loop = asyncio.new_event_loop()

    asyncio.set_event_loop(loop)

    for signal_name in (
        signal.SIGINT,
        signal.SIGTERM,
    ):
        with contextlib.suppress(
            NotImplementedError
        ):
            loop.add_signal_handler(
                signal_name,
                worker.request_stop,
            )

    lock_path = (
        config.runtime_dir /
        "ai_shopkeeper.lock"
    )

    pid_path = (
        config.runtime_dir /
        "ai_shopkeeper.pid"
    )

    try:
        with ProcessLock(
            lock_path,
            pid_path,
        ):
            loop.run_until_complete(
                worker.run_forever()
            )
    except KeyboardInterrupt:
        worker.request_stop()
    except Exception as error:
        LOG.exception(
            "AI worker failed: %s",
            error,
        )
        return 1
    finally:
        loop.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
