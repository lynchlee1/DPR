from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from functools import lru_cache
import gc
import io
import platform
from pathlib import Path
# Only a fixed macOS system command is executed below.
import subprocess  # nosec B404
import sys
import threading
import time
from typing import Literal
import uuid
import webbrowser

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from PIL import Image, ImageOps
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .core import clear_analysis_cache, scan_folder
from .storage import move_selection_to_storage
from .trash import move_selection_to_trash


PROJECT_ROOT = (
    Path(sys._MEIPASS)
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parents[2]
)
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"


class ScanRequest(BaseModel):
    folder: str = Field(min_length=1)
    threshold: float = Field(default=88, ge=0, le=100)
    time_window_seconds: int = Field(default=60, ge=1, le=3600)
    mode: Literal["standard", "quick"] = "standard"
    include_subfolders: bool = True
    day_limit: int | None = Field(default=None, ge=1)
    date_order: Literal["oldest", "newest"] = "oldest"


class TrashRequest(BaseModel):
    image_ids: list[str]
    allow_delete_all: bool = False


class StoreRequest(BaseModel):
    image_ids: list[str]
    destination: str = Field(min_length=1)


@dataclass
class ScanSession:
    id: str
    folder: str
    threshold: float
    time_window_seconds: int
    mode: Literal["standard", "quick"] = "standard"
    include_subfolders: bool = True
    day_limit: int | None = None
    date_order: Literal["oldest", "newest"] = "oldest"
    selected_date_start: str | None = None
    selected_date_end: str | None = None
    status: str = "queued"
    phase: str = "queued"
    completed: int = 0
    total: int = 0
    result: dict | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)

    def payload(self) -> dict:
        return {
            "id": self.id,
            "folder": self.folder,
            "threshold": self.threshold,
            "time_window_seconds": self.time_window_seconds,
            "mode": self.mode,
            "include_subfolders": self.include_subfolders,
            "day_limit": self.day_limit,
            "date_order": self.date_order,
            "selected_date_start": self.selected_date_start,
            "selected_date_end": self.selected_date_end,
            "status": self.status,
            "phase": self.phase,
            "completed": self.completed,
            "total": self.total,
            "result": self.result,
            "error": self.error,
        }


app = FastAPI(title="사진 정리", version="1.0.0")
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["127.0.0.1", "localhost"],
)
sessions: dict[str, ScanSession] = {}
sessions_lock = threading.Lock()


def _update_progress(session: ScanSession, completed: int, total: int, phase: str) -> None:
    with sessions_lock:
        session.completed = completed
        session.total = total
        session.phase = phase


def _update_date_range(
    session: ScanSession,
    selected_date_start: str | None,
    selected_date_end: str | None,
) -> None:
    with sessions_lock:
        session.selected_date_start = selected_date_start
        session.selected_date_end = selected_date_end


def _run_scan(session: ScanSession) -> None:
    with sessions_lock:
        session.status = "running"
    try:
        result = scan_folder(
            Path(session.folder),
            threshold=session.threshold,
            time_window_seconds=session.time_window_seconds,
            on_progress=lambda completed, total, phase: _update_progress(session, completed, total, phase),
            keeper_strategy="latest" if session.mode == "quick" else "quality",
            include_subfolders=session.include_subfolders,
            day_limit=session.day_limit,
            date_order=session.date_order,
            on_date_range=lambda start, end: _update_date_range(session, start, end),
        )
        with sessions_lock:
            session.result = result
            session.status = "complete"
            session.phase = "complete"
            session.completed = session.total
    except Exception as exc:
        with sessions_lock:
            session.status = "error"
            session.phase = "error"
            session.error = str(exc)


def _get_session(scan_id: str) -> ScanSession:
    with sessions_lock:
        session = sessions.get(scan_id)
    if session is None:
        raise HTTPException(status_code=404, detail="분석 결과를 찾을 수 없습니다.")
    return session


def _image_path(session: ScanSession, image_id: str) -> Path:
    if not session.result:
        raise HTTPException(status_code=409, detail="사진 분석이 아직 완료되지 않았습니다.")
    for group in session.result["groups"]:
        for image in group["images"]:
            if image["id"] == image_id:
                return Path(image["path"])
    raise HTTPException(status_code=404, detail="사진을 찾을 수 없습니다.")


@lru_cache(maxsize=512)
def _render_image(path_text: str, modified_ns: int, max_edge: int) -> bytes:
    del modified_ns  # Included in the cache key so replaced files invalidate naturally.
    path = Path(path_text)
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=86, optimize=True)
        return output.getvalue()


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.post("/api/calculations/reset")
def reset_calculations() -> dict:
    with sessions_lock:
        if any(session.status in {"queued", "running"} for session in sessions.values()):
            raise HTTPException(
                status_code=409,
                detail="사진 분석이 끝난 뒤 계산값을 초기화해 주세요.",
            )
        cleared_sessions = len(sessions)
        sessions.clear()

    cleared_analysis_entries = clear_analysis_cache()
    cleared_preview_entries = _render_image.cache_info().currsize
    _render_image.cache_clear()
    gc.collect()
    return {
        "cleared_sessions": cleared_sessions,
        "cleared_analysis_entries": cleared_analysis_entries,
        "cleared_preview_entries": cleared_preview_entries,
    }


@app.post("/api/folders/pick")
def pick_folder(
    purpose: Literal["source", "destination"] = Query(default="source"),
) -> dict:
    prompt = (
        "보관 사진을 저장할 폴더를 선택하세요"
        if purpose == "destination"
        else "정리할 사진 폴더를 선택하세요"
    )
    if platform.system() == "Darwin":
        script = f'POSIX path of (choose folder with prompt "{prompt}")'
        # The executable and AppleScript are fixed, with no shell involved.
        completed = subprocess.run(  # nosec B603
            ["/usr/bin/osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if completed.returncode != 0:
            return {"path": None}
        return {"path": completed.stdout.strip().rstrip("/")}

    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        path = filedialog.askdirectory(title=prompt)
        root.destroy()
        return {"path": path or None}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"폴더 선택기를 열 수 없습니다: {exc}") from exc


@app.post("/api/scans", status_code=202)
def create_scan(request: ScanRequest) -> dict:
    folder = Path(request.folder).expanduser().resolve()
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail="존재하는 폴더를 선택해 주세요.")

    session = ScanSession(
        id=uuid.uuid4().hex[:12],
        folder=str(folder),
        threshold=request.threshold,
        time_window_seconds=request.time_window_seconds,
        mode=request.mode,
        include_subfolders=request.include_subfolders,
        day_limit=request.day_limit,
        date_order=request.date_order,
    )
    with sessions_lock:
        sessions[session.id] = session
    threading.Thread(target=_run_scan, args=(session,), daemon=True).start()
    return session.payload()


@app.get("/api/scans/{scan_id}")
def get_scan(scan_id: str) -> dict:
    return _get_session(scan_id).payload()


@app.get("/api/scans/{scan_id}/images/{image_id}")
def get_image(
    scan_id: str,
    image_id: str,
    size: str = Query(default="preview", pattern="^(thumb|preview)$"),
) -> Response:
    session = _get_session(scan_id)
    path = _image_path(session, image_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="원본 사진을 찾을 수 없습니다.")
    max_edge = 320 if size == "thumb" else 1400
    data = _render_image(str(path), path.stat().st_mtime_ns, max_edge)
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@app.post("/api/scans/{scan_id}/trash")
def trash_marked(scan_id: str, request: TrashRequest) -> dict:
    session = _get_session(scan_id)
    if not session.result:
        raise HTTPException(status_code=409, detail="사진 분석이 아직 완료되지 않았습니다.")
    try:
        outcome = move_selection_to_trash(
            session.result,
            request.image_ids,
            allow_delete_all=request.allow_delete_all,
        )
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return outcome


@app.post("/api/scans/{scan_id}/store")
def store_kept(scan_id: str, request: StoreRequest) -> dict:
    session = _get_session(scan_id)
    if not session.result:
        raise HTTPException(status_code=409, detail="사진 분석이 아직 완료되지 않았습니다.")
    try:
        return move_selection_to_storage(
            session.result,
            request.image_ids,
            Path(request.destination),
        )
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")


def main() -> None:
    parser = argparse.ArgumentParser(description="사진 정리 로컬 앱")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(f"http://{args.host}:{args.port}")).start()

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
