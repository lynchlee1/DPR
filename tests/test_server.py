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
    server.sessions.pop(payload["id"], None)
