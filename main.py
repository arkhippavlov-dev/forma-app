from __future__ import annotations

import hashlib
import os
import tempfile
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

APP_VERSION = "0.21"
DEFAULT_MAX_UPLOAD_MB = 80
CHUNK_SIZE = 1024 * 1024


def _allowed_origins() -> list[str]:
    raw = os.getenv("FORMA_ALLOWED_ORIGINS", "*").strip()
    if not raw or raw == "*":
        return ["*"]
    return [item.strip() for item in raw.split(",") if item.strip()]


def _max_upload_bytes() -> int:
    raw = os.getenv("FORMA_MAX_UPLOAD_MB", str(DEFAULT_MAX_UPLOAD_MB))
    try:
        mb = max(1, int(raw))
    except ValueError:
        mb = DEFAULT_MAX_UPLOAD_MB
    return mb * 1024 * 1024


app = FastAPI(
    title="FORMA Backend",
    version=APP_VERSION,
    description=(
        "FORMA v0.21 backend foundation. Receives recorded approach videos "
        "and returns a verified receipt. Strong pose inference is added later."
    ),
)

origins = _allowed_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/")
async def root() -> dict:
    return {
        "ok": True,
        "service": "forma-backend",
        "version": APP_VERSION,
        "stage": "backend-foundation",
    }


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "service": "forma-backend",
        "version": APP_VERSION,
    }


@app.post("/api/v1/analyze")
async def analyze(
    video: Annotated[UploadFile, File(...)],
    exercise: Annotated[str, Form()] = "unknown",
    rep_count: Annotated[int, Form()] = 0,
    client_session_id: Annotated[str, Form()] = "",
    client_duration_ms: Annotated[int, Form()] = 0,
    pose_format_version: Annotated[str, Form()] = "forma-pose/v1",
) -> dict:
    """
    V0.21 contract:
    1. Receive the real recorded approach video.
    2. Stream it to temporary storage without loading the whole file in RAM.
    3. Verify non-zero bytes and calculate SHA-256.
    4. Delete the temporary file.
    5. Return a receipt that the browser can store for debugging.

    V0.22 will insert the strong pose model between steps 3 and 4.
    """

    request_id = str(uuid.uuid4())
    max_bytes = _max_upload_bytes()
    total_bytes = 0
    sha256 = hashlib.sha256()

    suffix = Path(video.filename or "approach.mp4").suffix or ".bin"
    temp_path: str | None = None

    try:
        with tempfile.NamedTemporaryFile(
            prefix="forma_",
            suffix=suffix,
            delete=False,
        ) as temp_file:
            temp_path = temp_file.name

            while True:
                chunk = await video.read(CHUNK_SIZE)
                if not chunk:
                    break

                total_bytes += len(chunk)

                if total_bytes > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"Video is larger than the current "
                            f"{max_bytes // (1024 * 1024)} MB limit."
                        ),
                    )

                sha256.update(chunk)
                temp_file.write(chunk)

        if total_bytes <= 0:
            raise HTTPException(
                status_code=400,
                detail="Uploaded video is empty.",
            )

        return {
            "ok": True,
            "request_id": request_id,
            "service_version": APP_VERSION,
            "stage": "backend-foundation",
            "exercise": exercise,
            "client": {
                "session_id": client_session_id,
                "rep_count": rep_count,
                "duration_ms": client_duration_ms,
                "pose_format_version": pose_format_version,
            },
            "video": {
                "received": True,
                "filename": video.filename,
                "content_type": video.content_type,
                "size_bytes": total_bytes,
                "sha256": sha256.hexdigest(),
            },
            "next_stage": "strong-pose-model",
        }

    finally:
        await video.close()

        if temp_path:
            try:
                Path(temp_path).unlink(missing_ok=True)
            except OSError:
                pass
