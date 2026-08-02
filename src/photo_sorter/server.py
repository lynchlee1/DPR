from __future__ import annotations

import argparse
from collections import OrderedDict
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

from .core import (
    SUPPORTED_EXTENSIONS,
    SUPPORTED_VIDEO_EXTENSIONS,
    ScanCancelled,
    analysis_cache_groups,
    clear_analysis_cache,
    scan_folder,
)
from .storage import move_selection_to_storage
from .trash import move_selection_to_trash


PROJECT_ROOT = (
    Path(sys._MEIPASS)
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parents[2]
)
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"


class ScanRequest(BaseModel):
    folder: str = ""
    folders: list[str] = Field(default_factory=list)
    threshold: float = Field(default=88, ge=0, le=100)
    time_window_seconds: int = Field(default=60, ge=1, le=3600)
    mode: Literal["standard", "quick"] = "standard"
    include_subfolders: bool = True
    day_limit: int | None = Field(default=None, ge=1)
    date_order: Literal["oldest", "newest"] = "oldest"
    cleanup_json_files: bool = False


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
    folders: list[str] = field(default_factory=list)
    mode: Literal["standard", "quick"] = "standard"
    include_subfolders: bool = True
    day_limit: int | None = None
    date_order: Literal["oldest", "newest"] = "oldest"
    cleanup_json_files: bool = False
    selected_date_start: str | None = None
    selected_date_end: str | None = None
    status: str = "queued"
    phase: str = "queued"
    completed: int = 0
    total: int = 0
    result: dict | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    source_signature: tuple[tuple[str, int, int], ...] = field(default_factory=tuple, repr=False)
    active_operation: str | None = field(default=None, repr=False)
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)

    def payload(self) -> dict:
        return {
            "id": self.id,
            "folder": self.folder,
            "folders": self.folders or [self.folder],
            "threshold": self.threshold,
            "time_window_seconds": self.time_window_seconds,
            "mode": self.mode,
            "include_subfolders": self.include_subfolders,
            "day_limit": self.day_limit,
            "date_order": self.date_order,
            "cleanup_json_files": self.cleanup_json_files,
            "selected_date_start": self.selected_date_start,
            "selected_date_end": self.selected_date_end,
            "status": self.status,
            "phase": self.phase,
            "completed": self.completed,
            "total": self.total,
            "result": self.result,
            "error": self.error,
        }


app = FastAPI(title="사진 정리", version="1.0.4")
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["127.0.0.1", "localhost"],
)
sessions: dict[str, ScanSession] = {}
sessions_lock = threading.Lock()
PREVIEW_CACHE_MAX_SIZE = 512
_preview_cache_keys: OrderedDict[tuple[str, int, int], tuple[str, int]] = OrderedDict()
_preview_cache_lock = threading.Lock()


def _source_signature(
    folder: Path | list[Path],
    include_subfolders: bool,
    include_json: bool,
) -> tuple[tuple[str, int, int], ...]:
    folders = folder if isinstance(folder, list) else [folder]
    supported = SUPPORTED_EXTENSIONS | SUPPORTED_VIDEO_EXTENSIONS
    if include_json:
        supported = supported | {".json"}
    signature: list[tuple[str, int, int]] = []
    for source_folder in folders:
        candidates = source_folder.rglob("*") if include_subfolders else source_folder.iterdir()
        for path in candidates:
            if not path.is_file() or path.suffix.lower() not in supported:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            signature.append((str(path.resolve()), stat.st_mtime_ns, stat.st_size))
    return tuple(sorted(signature))


def _same_scan(session: ScanSession, request: ScanRequest, folders: list[Path]) -> bool:
    return (
        (session.folders or [session.folder]) == [str(folder) for folder in folders]
        and session.threshold == request.threshold
        and session.time_window_seconds == request.time_window_seconds
        and session.mode == request.mode
        and session.include_subfolders == request.include_subfolders
        and session.day_limit == request.day_limit
        and session.date_order == request.date_order
        and session.cleanup_json_files == request.cleanup_json_files
    )


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
        session.active_operation = "scan"
    try:
        result = scan_folder(
            [Path(folder) for folder in (session.folders or [session.folder])],
            threshold=session.threshold,
            time_window_seconds=session.time_window_seconds,
            on_progress=lambda completed, total, phase: _update_progress(session, completed, total, phase),
            keeper_strategy="latest" if session.mode == "quick" else "quality",
            include_subfolders=session.include_subfolders,
            day_limit=session.day_limit,
            date_order=session.date_order,
            on_date_range=lambda start, end: _update_date_range(session, start, end),
            cleanup_json_files=session.cleanup_json_files,
            should_cancel=session.cancel_event.is_set,
        )
        signature = _source_signature(
            [Path(folder) for folder in (session.folders or [session.folder])],
            session.include_subfolders,
            session.cleanup_json_files,
        )
        with sessions_lock:
            session.result = result
            session.source_signature = signature
            session.status = "complete"
            session.phase = "complete"
            session.completed = session.total
    except ScanCancelled:
        with sessions_lock:
            session.status = "cancelled"
            session.phase = "cancelled"
            session.error = None
    except Exception as exc:
        with sessions_lock:
            session.status = "error"
            session.phase = "error"
            session.error = str(exc)
    finally:
        with sessions_lock:
            session.active_operation = None


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


@lru_cache(maxsize=PREVIEW_CACHE_MAX_SIZE)
def _render_image(path_text: str, modified_ns: int, max_edge: int) -> bytes:
    del modified_ns  # Included in the cache key so replaced files invalidate naturally.
    path = Path(path_text)
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=86, optimize=True)
        return output.getvalue()


def _deep_size(value: object, seen: set[int] | None = None) -> int:
    """Estimate retained Python memory without counting shared objects twice."""
    seen = seen or set()
    value_id = id(value)
    if value_id in seen:
        return 0
    seen.add(value_id)
    size = sys.getsizeof(value)
    if isinstance(value, dict):
        size += sum(_deep_size(key, seen) + _deep_size(item, seen) for key, item in value.items())
    elif isinstance(value, (list, tuple, set, frozenset)):
        size += sum(_deep_size(item, seen) for item in value)
    return size


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.post("/api/calculations/reset")
def reset_calculations() -> dict:
    with sessions_lock:
        if any(
            session.status in {"queued", "running", "cancelling"} or session.active_operation
            for session in sessions.values()
        ):
            raise HTTPException(
                status_code=409,
                detail="사진 분석이 끝난 뒤 계산값을 초기화해 주세요.",
            )
        cleared_sessions = len(sessions)
        sessions.clear()

    cleared_analysis_entries = clear_analysis_cache()
    cleared_preview_entries = _render_image.cache_info().currsize
    _render_image.cache_clear()
    with _preview_cache_lock:
        _preview_cache_keys.clear()
    gc.collect()
    return {
        "cleared_sessions": cleared_sessions,
        "cleared_analysis_entries": cleared_analysis_entries,
        "cleared_preview_entries": cleared_preview_entries,
    }


@app.get("/api/calculations/cache")
def get_calculation_cache() -> dict:
    usage_by_folder: dict[str, dict[str, int]] = {}

    def usage_for(folder_text: str) -> dict[str, int]:
        return usage_by_folder.setdefault(folder_text, {
            "analysis_count": 0,
            "analysis_bytes": 0,
            "preview_count": 0,
            "preview_bytes": 0,
            "result_count": 0,
            "result_bytes": 0,
        })

    for group in analysis_cache_groups():
        usage = usage_for(group["path"])
        usage["analysis_count"] += group["entry_count"]
        usage["analysis_bytes"] += group["estimated_bytes"]

    with _preview_cache_lock:
        preview_entries = list(_preview_cache_keys.values())
    for folder_text, byte_count in preview_entries:
        usage = usage_for(folder_text)
        usage["preview_count"] += 1
        usage["preview_bytes"] += byte_count

    with sessions_lock:
        session_snapshot = list(sessions.values())
    for session in session_snapshot:
        if session.result is None:
            continue
        result_bytes = _deep_size(session.result)
        images = [image for group in session.result.get("groups", []) for image in group.get("images", [])]
        weights_by_folder: dict[str, int] = {}
        counts_by_folder: dict[str, int] = {}
        for image in images:
            folder_text = str(Path(image["path"]).parent)
            weights_by_folder[folder_text] = weights_by_folder.get(folder_text, 0) + _deep_size(image)
            counts_by_folder[folder_text] = counts_by_folder.get(folder_text, 0) + 1
        if not weights_by_folder:
            usage_for(session.folder)["result_bytes"] += result_bytes
            continue
        total_weight = sum(weights_by_folder.values())
        remaining_bytes = result_bytes
        folders = list(weights_by_folder)
        for index, folder_text in enumerate(folders):
            allocated = (
                remaining_bytes
                if index == len(folders) - 1
                else result_bytes * weights_by_folder[folder_text] // total_weight
            )
            remaining_bytes -= allocated
            usage = usage_for(folder_text)
            usage["result_count"] += counts_by_folder[folder_text]
            usage["result_bytes"] += allocated

    groups = []
    for folder_text, usage in usage_by_folder.items():
        total_bytes = usage["analysis_bytes"] + usage["preview_bytes"] + usage["result_bytes"]
        groups.append({
            "name": Path(folder_text).name or folder_text,
            "path": folder_text,
            "total_bytes": total_bytes,
            **usage,
        })
    groups.sort(key=lambda group: (-group["total_bytes"], group["path"].casefold()))
    return {
        "total_bytes": sum(group["total_bytes"] for group in groups),
        "analysis_entry_count": sum(group["analysis_count"] for group in groups),
        "preview_entry_count": sum(group["preview_count"] for group in groups),
        "result_entry_count": sum(group["result_count"] for group in groups),
        "session_count": len(session_snapshot),
        "groups": groups,
    }


@app.post("/api/folders/pick")
def pick_folder(
    purpose: Literal["source", "destination"] = "source",
    multiple: bool = False,
) -> dict:
    prompt = (
        "보관 사진을 저장할 폴더를 선택하세요"
        if purpose == "destination"
        else "정리할 사진 폴더를 선택하세요"
    )
    if platform.system() == "Darwin":
        if purpose == "source" and multiple:
            script = (
                f'set selectedFolders to choose folder with prompt "{prompt}" with multiple selections allowed\n'
                'set selectedPaths to ""\n'
                'repeat with selectedFolder in selectedFolders\n'
                'set selectedPaths to selectedPaths & POSIX path of selectedFolder & linefeed\n'
                'end repeat\n'
                'return selectedPaths'
            )
        else:
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
            return {"path": None, "paths": []}
        paths = [line.rstrip("/") for line in completed.stdout.splitlines() if line.strip()]
        return {"path": paths[0] if paths else None, "paths": paths}

    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        path = filedialog.askdirectory(title=prompt)
        root.destroy()
        return {"path": path or None, "paths": [path] if path else []}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"폴더 선택기를 열 수 없습니다: {exc}") from exc


@app.get("/api/folders/browse")
def browse_folders(path: str | None = Query(default=None)) -> dict:
    target = Path(path).expanduser().resolve() if path else Path.home().resolve()
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="존재하는 폴더를 열어 주세요.")

    try:
        folders = sorted(
            (
                {"name": child.name, "path": str(child.resolve())}
                for child in target.iterdir()
                if child.is_dir() and not child.name.startswith(".")
            ),
            key=lambda item: item["name"].casefold(),
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="이 폴더를 열 권한이 없습니다.") from exc
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"폴더를 열 수 없습니다: {exc}") from exc

    home = Path.home().resolve()
    shortcut_candidates = [
        ("홈", home),
        ("사진", home / "Pictures"),
        ("다운로드", home / "Downloads"),
        ("문서", home / "Documents"),
    ]
    shortcuts = [
        {"name": name, "path": str(shortcut.resolve())}
        for name, shortcut in shortcut_candidates
        if shortcut.is_dir()
    ]
    parent = target.parent
    return {
        "path": str(target),
        "parent": str(parent) if parent != target else None,
        "folders": folders,
        "shortcuts": shortcuts,
    }


@app.post("/api/scans", status_code=202)
def create_scan(request: ScanRequest) -> dict:
    requested_folders = request.folders or ([request.folder] if request.folder else [])
    folders = list(dict.fromkeys(Path(folder).expanduser().resolve() for folder in requested_folders))
    if not folders:
        raise HTTPException(status_code=400, detail="분석할 폴더를 선택해 주세요.")
    if any(not folder.is_dir() for folder in folders):
        raise HTTPException(status_code=400, detail="선택한 폴더 중 존재하지 않는 폴더가 있습니다.")
    folder = folders[0]

    signature = _source_signature(folders, request.include_subfolders, request.cleanup_json_files)
    with sessions_lock:
        reusable = next(
            (
                existing
                for existing in reversed(list(sessions.values()))
                if existing.status == "complete"
                and existing.result is not None
                and existing.source_signature == signature
                and _same_scan(existing, request, folders)
            ),
            None,
        )
    if reusable is not None:
        payload = reusable.payload()
        payload["reused"] = True
        return payload

    session = ScanSession(
        id=uuid.uuid4().hex[:12],
        folder=str(folder),
        folders=[str(item) for item in folders],
        threshold=request.threshold,
        time_window_seconds=request.time_window_seconds,
        mode=request.mode,
        include_subfolders=request.include_subfolders,
        day_limit=request.day_limit,
        date_order=request.date_order,
        cleanup_json_files=request.cleanup_json_files,
        source_signature=signature,
        active_operation="scan",
    )
    with sessions_lock:
        sessions[session.id] = session
    threading.Thread(target=_run_scan, args=(session,), daemon=True).start()
    return session.payload()


@app.get("/api/scans/{scan_id}")
def get_scan(scan_id: str) -> dict:
    return _get_session(scan_id).payload()


@app.post("/api/scans/{scan_id}/cancel", status_code=202)
def cancel_operation(scan_id: str) -> dict:
    session = _get_session(scan_id)
    with sessions_lock:
        if not session.active_operation:
            raise HTTPException(status_code=409, detail="중단할 작업이 없습니다.")
        operation = session.active_operation
        session.cancel_event.set()
        if operation == "scan":
            session.status = "cancelling"
            session.phase = "cancelling"
    return {"accepted": True, "operation": operation}


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
    cache_key = (str(path), path.stat().st_mtime_ns, max_edge)
    data = _render_image(*cache_key)
    with _preview_cache_lock:
        _preview_cache_keys.pop(cache_key, None)
        _preview_cache_keys[cache_key] = (str(path.parent), len(data))
        while len(_preview_cache_keys) > PREVIEW_CACHE_MAX_SIZE:
            _preview_cache_keys.popitem(last=False)
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@app.post("/api/scans/{scan_id}/trash")
def trash_marked(scan_id: str, request: TrashRequest) -> dict:
    session = _get_session(scan_id)
    if not session.result:
        raise HTTPException(status_code=409, detail="사진 분석이 아직 완료되지 않았습니다.")
    with sessions_lock:
        if session.active_operation:
            raise HTTPException(status_code=409, detail="다른 작업이 진행 중입니다.")
        session.cancel_event.clear()
        session.active_operation = "trash"
    try:
        outcome = move_selection_to_trash(
            session.result,
            request.image_ids,
            allow_delete_all=request.allow_delete_all,
            should_cancel=session.cancel_event.is_set,
        )
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        with sessions_lock:
            session.active_operation = None
    return outcome


@app.post("/api/scans/{scan_id}/store")
def store_kept(scan_id: str, request: StoreRequest) -> dict:
    session = _get_session(scan_id)
    if not session.result:
        raise HTTPException(status_code=409, detail="사진 분석이 아직 완료되지 않았습니다.")
    with sessions_lock:
        if session.active_operation:
            raise HTTPException(status_code=409, detail="다른 작업이 진행 중입니다.")
        session.cancel_event.clear()
        session.active_operation = "store"
    try:
        return move_selection_to_storage(
            session.result,
            request.image_ids,
            Path(request.destination),
            should_cancel=session.cancel_event.is_set,
        )
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        with sessions_lock:
            session.active_operation = None


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
