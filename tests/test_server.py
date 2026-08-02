from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image
from photo_sorter import server


class DeferredThread:
    def __init__(self, *args, **kwargs) -> None:
        pass

    def start(self) -> None:
        pass


def test_macos_folder_picker_uses_simple_single_selection_by_default(monkeypatch) -> None:
    received: dict = {}

    def fake_run(command, **kwargs):
        received["command"] = command
        return SimpleNamespace(returncode=0, stdout="/tmp/photos/\n")

    monkeypatch.setattr(server.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(server.subprocess, "run", fake_run)

    result = server.pick_folder()

    assert "multiple selections allowed" not in received["command"][2]
    assert result == {"path": "/tmp/photos", "paths": ["/tmp/photos"]}


def test_macos_folder_picker_can_select_multiple_folders_at_once(monkeypatch) -> None:
    received: dict = {}

    def fake_run(command, **kwargs):
        received["command"] = command
        return SimpleNamespace(returncode=0, stdout="/tmp/camera/\n/tmp/phone/\n")

    monkeypatch.setattr(server.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(server.subprocess, "run", fake_run)

    result = server.pick_folder(multiple=True)

    assert "multiple selections allowed" in received["command"][2]
    assert result == {
        "path": "/tmp/camera",
        "paths": ["/tmp/camera", "/tmp/phone"],
    }


def test_browse_folders_lists_visible_directories(tmp_path: Path) -> None:
    (tmp_path / "Camera").mkdir()
    (tmp_path / "phone").mkdir()
    (tmp_path / ".hidden").mkdir()
    (tmp_path / "notes.txt").write_text("not a folder")

    result = server.browse_folders(str(tmp_path))

    assert result["path"] == str(tmp_path.resolve())
    assert result["parent"] == str(tmp_path.resolve().parent)
    assert result["folders"] == [
        {"name": "Camera", "path": str((tmp_path / "Camera").resolve())},
        {"name": "phone", "path": str((tmp_path / "phone").resolve())},
    ]


def test_browse_folders_rejects_missing_directory(tmp_path: Path) -> None:
    with pytest.raises(server.HTTPException) as exc_info:
        server.browse_folders(str(tmp_path / "missing"))

    assert exc_info.value.status_code == 400


def test_browse_folders_reveals_existing_selection_first(tmp_path: Path) -> None:
    selected = tmp_path / "Selected photos"
    other = tmp_path / "Archive"
    selected.mkdir()
    other.mkdir()

    result = server.browse_folders(reveal=str(selected))

    assert result["path"] == str(tmp_path.resolve())
    assert result["revealed"] == str(selected.resolve())
    assert result["folders"][0] == {
        "name": "Selected photos",
        "path": str(selected.resolve()),
    }


def test_quick_scan_respects_requested_threshold(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(server.threading, "Thread", DeferredThread)
    request = server.ScanRequest(folder=str(tmp_path), threshold=91, mode="quick")

    payload = server.create_scan(request)

    assert payload["mode"] == "quick"
    assert payload["threshold"] == 91
    assert payload["include_subfolders"] is True
    server.sessions.pop(payload["id"], None)


def test_scan_preserves_subfolder_choice(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(server.threading, "Thread", DeferredThread)
    request = server.ScanRequest(folder=str(tmp_path), include_subfolders=False)

    payload = server.create_scan(request)

    assert payload["include_subfolders"] is False
    server.sessions.pop(payload["id"], None)


def test_scan_preserves_multiple_selected_folders(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(server.threading, "Thread", DeferredThread)
    first_folder = tmp_path / "camera"
    second_folder = tmp_path / "phone"
    first_folder.mkdir()
    second_folder.mkdir()
    request = server.ScanRequest(folders=[str(first_folder), str(second_folder)])

    payload = server.create_scan(request)

    assert payload["folder"] == str(first_folder.resolve())
    assert payload["folders"] == [str(first_folder.resolve()), str(second_folder.resolve())]
    server.sessions.pop(payload["id"], None)


def test_scan_preserves_json_cleanup_choice(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(server.threading, "Thread", DeferredThread)
    request = server.ScanRequest(folder=str(tmp_path), cleanup_json_files=True)

    payload = server.create_scan(request)

    assert payload["cleanup_json_files"] is True
    server.sessions.pop(payload["id"], None)


def test_scan_preserves_date_limit_and_order(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(server.threading, "Thread", DeferredThread)
    request = server.ScanRequest(folder=str(tmp_path), day_limit=12, date_order="newest")

    payload = server.create_scan(request)

    assert payload["day_limit"] == 12
    assert payload["date_order"] == "newest"
    server.sessions.pop(payload["id"], None)


def test_scan_reuses_completed_result_when_files_and_settings_match(tmp_path: Path) -> None:
    photo = tmp_path / "photo.jpg"
    photo.write_bytes(b"photo")
    request = server.ScanRequest(folder=str(tmp_path))
    session = server.ScanSession(
        id="reusable-scan",
        folder=str(tmp_path.resolve()),
        threshold=88,
        time_window_seconds=60,
        status="complete",
        phase="complete",
        result={"folder": str(tmp_path.resolve()), "groups": []},
        source_signature=server._source_signature(tmp_path, True, False),
    )
    server.sessions[session.id] = session

    payload = server.create_scan(request)

    assert payload["id"] == session.id
    assert payload["status"] == "complete"
    assert payload["reused"] is True
    server.sessions.pop(session.id, None)


def test_scan_does_not_reuse_result_after_a_file_changes(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(server.threading, "Thread", DeferredThread)
    photo = tmp_path / "photo.jpg"
    photo.write_bytes(b"before")
    request = server.ScanRequest(folder=str(tmp_path))
    previous = server.ScanSession(
        id="old-scan",
        folder=str(tmp_path.resolve()),
        threshold=88,
        time_window_seconds=60,
        status="complete",
        result={"folder": str(tmp_path.resolve()), "groups": []},
        source_signature=server._source_signature(tmp_path, True, False),
    )
    server.sessions[previous.id] = previous
    photo.write_bytes(b"after-change")

    payload = server.create_scan(request)

    assert payload["id"] != previous.id
    assert payload["status"] == "queued"
    server.sessions.pop(previous.id, None)
    server.sessions.pop(payload["id"], None)


def test_cancel_running_scan_sets_cooperative_cancel_signal() -> None:
    session = server.ScanSession(
        id="running-cancel",
        folder="/tmp/photos",
        threshold=88,
        time_window_seconds=60,
        status="running",
        active_operation="scan",
    )
    server.sessions[session.id] = session

    payload = server.cancel_operation(session.id)

    assert payload == {"accepted": True, "operation": "scan"}
    assert session.cancel_event.is_set()
    assert session.status == "cancelling"
    server.sessions.pop(session.id, None)


def test_scan_worker_passes_subfolder_choice(tmp_path: Path, monkeypatch) -> None:
    received: dict = {}

    def fake_scan(folder: Path, **kwargs) -> dict:
        received.update(kwargs)
        kwargs["on_date_range"]("2024-01-03", "2024-01-09")
        return {"groups": []}

    monkeypatch.setattr(server, "scan_folder", fake_scan)
    session = server.ScanSession(
        id="test-scan",
        folder=str(tmp_path),
        threshold=88,
        time_window_seconds=60,
        include_subfolders=False,
        day_limit=7,
        date_order="newest",
    )

    server._run_scan(session)

    assert received["include_subfolders"] is False
    assert received["day_limit"] == 7
    assert received["date_order"] == "newest"
    assert received["cleanup_json_files"] is False
    assert session.selected_date_start == "2024-01-03"
    assert session.selected_date_end == "2024-01-09"
    assert session.status == "complete"


def test_reset_calculations_clears_sessions_and_caches(monkeypatch) -> None:
    session = server.ScanSession(
        id="completed-scan",
        folder="/tmp/photos",
        threshold=88,
        time_window_seconds=60,
        status="complete",
        result={"groups": []},
    )
    server.sessions[session.id] = session
    preview_cache_cleared = False

    def clear_preview_cache() -> None:
        nonlocal preview_cache_cleared
        preview_cache_cleared = True

    monkeypatch.setattr(server, "clear_analysis_cache", lambda: 7)
    monkeypatch.setattr(server._render_image, "cache_info", lambda: SimpleNamespace(currsize=3))
    monkeypatch.setattr(server._render_image, "cache_clear", clear_preview_cache)
    monkeypatch.setattr(server.gc, "collect", lambda: 0)

    result = server.reset_calculations()

    assert result == {
        "cleared_sessions": 1,
        "cleared_analysis_entries": 7,
        "cleared_preview_entries": 3,
    }
    assert preview_cache_cleared is True
    assert server.sessions == {}


def test_reset_calculations_rejects_running_scan() -> None:
    session = server.ScanSession(
        id="running-scan",
        folder="/tmp/photos",
        threshold=88,
        time_window_seconds=60,
        status="running",
    )
    server.sessions[session.id] = session

    with pytest.raises(server.HTTPException) as exc_info:
        server.reset_calculations()

    assert exc_info.value.status_code == 409
    server.sessions.pop(session.id, None)


def test_get_calculation_cache_lists_memory_by_real_folder(monkeypatch) -> None:
    monkeypatch.setattr(server, "analysis_cache_groups", lambda: [
        {"name": "photos", "path": "/tmp/photos", "entry_count": 2, "estimated_bytes": 200},
    ])
    server.sessions["cached-scan"] = server.ScanSession(
        id="cached-scan",
        folder="/tmp/photos",
        threshold=88,
        time_window_seconds=60,
        status="complete",
    )

    assert server.get_calculation_cache() == {
        "total_bytes": 200,
        "analysis_entry_count": 2,
        "preview_entry_count": 0,
        "result_entry_count": 0,
        "session_count": 1,
        "groups": [
            {
                "name": "photos",
                "path": "/tmp/photos",
                "total_bytes": 200,
                "analysis_count": 2,
                "analysis_bytes": 200,
                "preview_count": 0,
                "preview_bytes": 0,
                "result_count": 0,
                "result_bytes": 0,
            },
        ],
    }
    server.sessions.pop("cached-scan", None)


def test_calculation_cache_includes_preview_and_completed_result_memory(tmp_path: Path, monkeypatch) -> None:
    folder = tmp_path / "actual-folder"
    folder.mkdir()
    photo = folder / "photo.jpg"
    Image.new("RGB", (40, 30), (20, 40, 60)).save(photo)
    session = server.ScanSession(
        id="memory-scan",
        folder=str(tmp_path),
        threshold=88,
        time_window_seconds=60,
        status="complete",
        result={"groups": [{"images": [{"id": "photo-1", "path": str(photo)}]}]},
    )
    server.sessions[session.id] = session
    monkeypatch.setattr(server, "analysis_cache_groups", lambda: [])

    response = server.get_image(session.id, "photo-1", "thumb")
    payload = server.get_calculation_cache()

    assert payload["preview_entry_count"] == 1
    assert payload["result_entry_count"] == 1
    assert len(payload["groups"]) == 1
    group = payload["groups"][0]
    assert group["path"] == str(folder)
    assert group["preview_count"] == 1
    assert group["preview_bytes"] == len(response.body)
    assert group["result_count"] == 1
    assert group["result_bytes"] > 0
    assert group["total_bytes"] == group["preview_bytes"] + group["result_bytes"]

    server.sessions.pop(session.id, None)
    server._render_image.cache_clear()
    with server._preview_cache_lock:
        server._preview_cache_keys.clear()


def test_store_kept_passes_selection_and_destination(tmp_path: Path, monkeypatch) -> None:
    session = server.ScanSession(
        id="storage-scan",
        folder=str(tmp_path),
        threshold=88,
        time_window_seconds=60,
        status="complete",
        result={"folder": str(tmp_path), "groups": []},
    )
    server.sessions[session.id] = session
    received: dict = {}

    def fake_store(result: dict, image_ids: list[str], destination: Path, **kwargs) -> dict:
        received.update(
            result=result,
            image_ids=image_ids,
            destination=destination,
            should_cancel=kwargs.get("should_cancel"),
        )
        return {"moved": [], "failures": []}

    monkeypatch.setattr(server, "move_selection_to_storage", fake_store)

    outcome = server.store_kept(
        session.id,
        server.StoreRequest(
            image_ids=["photo-1"],
            destination=str(tmp_path / "archive"),
        ),
    )

    assert outcome == {"moved": [], "failures": []}
    assert received["result"] is session.result
    assert received["image_ids"] == ["photo-1"]
    assert received["destination"] == tmp_path / "archive"
    assert callable(received["should_cancel"])
    server.sessions.pop(session.id, None)
