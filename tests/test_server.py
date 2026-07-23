from pathlib import Path

from photo_sorter import server


class DeferredThread:
    def __init__(self, *args, **kwargs) -> None:
        pass

    def start(self) -> None:
        pass


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


def test_scan_worker_passes_subfolder_choice(tmp_path: Path, monkeypatch) -> None:
    received: dict = {}

    def fake_scan(folder: Path, **kwargs) -> dict:
        received.update(kwargs)
        return {"groups": []}

    monkeypatch.setattr(server, "scan_folder", fake_scan)
    session = server.ScanSession(
        id="test-scan",
        folder=str(tmp_path),
        threshold=88,
        time_window_seconds=60,
        include_subfolders=False,
    )

    server._run_scan(session)

    assert received["include_subfolders"] is False
    assert session.status == "complete"
