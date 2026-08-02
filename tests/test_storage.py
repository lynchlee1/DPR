import errno
from pathlib import Path
import shutil

import pytest

from photo_sorter.storage import (
    inspect_source_directories,
    move_selection_to_storage,
    validate_storage_selection,
)
from photo_sorter.trash import move_selection_to_trash


def make_result(source: Path) -> dict:
    first = source / "first.jpg"
    second = source / "second.jpg"
    first.write_bytes(b"first")
    second.write_bytes(b"second")
    return {
        "folder": str(source),
        "groups": [
            {
                "images": [
                    {
                        "id": "first",
                        "path": str(first),
                        "captured_at": "2024-01-02T10:00:00",
                    },
                    {
                        "id": "second",
                        "path": str(second),
                        "captured_at": "2024-03-04T11:00:00",
                    },
                ]
            }
        ],
    }


def test_moves_photos_into_capture_date_directories(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "archive"
    source.mkdir()
    destination.mkdir()
    result = make_result(source)

    outcome = move_selection_to_storage(
        result,
        ["first", "second"],
        destination,
    )

    assert outcome["failures"] == []
    assert outcome["moved"] == [
        {
            "source": str(source / "first.jpg"),
            "destination": str(destination / "Photos" / "20240102" / "first.jpg"),
        },
        {
            "source": str(source / "second.jpg"),
            "destination": str(destination / "Photos" / "20240304" / "second.jpg"),
        },
    ]
    assert not (source / "first.jpg").exists()
    assert not (source / "second.jpg").exists()
    assert (destination / "Photos" / "20240102" / "first.jpg").read_bytes() == b"first"
    assert (destination / "Photos" / "20240304" / "second.jpg").read_bytes() == b"second"


def test_inspects_all_files_remaining_in_source_directories(tmp_path: Path) -> None:
    source = tmp_path / "source"
    nested = source / "nested"
    source.mkdir()
    nested.mkdir()
    (source / "note.txt").write_bytes(b"note")
    (nested / "metadata.json").write_bytes(b"metadata")

    check = inspect_source_directories({"folder": str(source)})

    assert check["is_empty"] is False
    assert check["file_count"] == 2
    assert check["size_bytes"] == 12
    assert check["directories"] == [
        {
            "path": str(source),
            "file_count": 2,
            "size_bytes": 12,
            "error": None,
        }
    ]
    assert check["errors"] == []


def test_source_directory_inspection_confirms_empty_directory(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()

    check = inspect_source_directories({"folder": str(source)})

    assert check["is_empty"] is True
    assert check["file_count"] == 0
    assert check["size_bytes"] == 0


def test_moves_photo_from_single_photo_group(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "archive"
    source.mkdir()
    destination.mkdir()
    result = make_result(source)
    result["groups"][0]["images"] = [result["groups"][0]["images"][0]]

    outcome = move_selection_to_storage(result, ["first"], destination)

    assert outcome["failures"] == []
    assert outcome["moved"] == [
        {
            "source": str(source / "first.jpg"),
            "destination": str(destination / "Photos" / "20240102" / "first.jpg"),
        }
    ]
    assert (destination / "Photos" / "20240102" / "first.jpg").read_bytes() == b"first"


def test_storage_move_stops_between_files(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "archive"
    source.mkdir()
    destination.mkdir()
    result = make_result(source)
    cancelled = False

    def mover(source_path: str, destination_path: str) -> None:
        nonlocal cancelled
        Path(source_path).rename(destination_path)
        cancelled = True

    outcome = move_selection_to_storage(
        result,
        ["first", "second"],
        destination,
        mover=mover,
        should_cancel=lambda: cancelled,
    )

    assert outcome["cancelled"] is True
    assert len(outcome["moved"]) == 1
    assert sum(path.exists() for path in (source / "first.jpg", source / "second.jpg")) == 1


def test_existing_filename_with_different_hash_is_not_overwritten(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "archive"
    source.mkdir()
    destination.mkdir()
    result = make_result(source)
    target_folder = destination / "Photos" / "20240102"
    target_folder.mkdir(parents=True)
    existing = target_folder / "first.jpg"
    existing.write_bytes(b"other")

    outcome = move_selection_to_storage(result, ["first"], destination)

    renamed = target_folder / "first (1).jpg"
    assert outcome["moved"][0]["destination"] == str(renamed)
    assert existing.read_bytes() == b"other"
    assert renamed.read_bytes() == b"first"


def test_existing_file_with_same_hash_is_overwritten(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "archive"
    source.mkdir()
    destination.mkdir()
    result = make_result(source)
    target_folder = destination / "Photos" / "20240102"
    target_folder.mkdir(parents=True)
    existing = target_folder / "first.jpg"
    existing.write_bytes(b"first")

    def reject_rename(source_path: str, destination_path: str) -> None:
        raise OSError(errno.EXDEV, "cross-device link", destination_path)

    monkeypatch.setattr(shutil.os, "rename", reject_rename)

    outcome = move_selection_to_storage(result, ["first"], destination)

    assert outcome["failures"] == []
    assert outcome["moved"] == [
        {"source": str(source / "first.jpg"), "destination": str(existing)}
    ]
    assert not (source / "first.jpg").exists()
    assert existing.read_bytes() == b"first"
    assert not (target_folder / "first (1).jpg").exists()


def test_video_name_collision_uses_hash_only_for_overwrite_decision(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "archive"
    source.mkdir()
    destination.mkdir()
    video = source / "clip.mp4"
    video.write_bytes(b"new video")
    result = {
        "folder": str(source),
        "groups": [{"images": [{
            "id": "video",
            "path": str(video),
            "captured_at": "2024-06-07T08:09:10",
        }]}],
    }
    target_folder = destination / "Photos" / "20240607"
    target_folder.mkdir(parents=True)
    existing = target_folder / "clip.mp4"
    existing.write_bytes(b"different video")

    outcome = move_selection_to_storage(result, ["video"], destination)

    renamed = target_folder / "clip (1).mp4"
    assert outcome["failures"] == []
    assert outcome["moved"] == [{"source": str(video), "destination": str(renamed)}]
    assert existing.read_bytes() == b"different video"
    assert renamed.read_bytes() == b"new video"


def test_video_with_same_hash_overwrites_existing_name(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "archive"
    source.mkdir()
    destination.mkdir()
    video = source / "clip.mp4"
    video.write_bytes(b"same video")
    result = {
        "folder": str(source),
        "groups": [{"images": [{
            "id": "video",
            "path": str(video),
            "captured_at": "2024-06-07T08:09:10",
        }]}],
    }
    existing = destination / "Photos" / "20240607" / "clip.mp4"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"same video")

    outcome = move_selection_to_storage(result, ["video"], destination)

    assert outcome["failures"] == []
    assert outcome["moved"] == [{"source": str(video), "destination": str(existing)}]
    assert not video.exists()
    assert existing.read_bytes() == b"same video"
    assert not (existing.parent / "clip (1).mp4").exists()


def test_kept_photo_can_be_stored_after_candidate_moves_to_trash(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "archive"
    fake_trash = tmp_path / "trash"
    source.mkdir()
    destination.mkdir()
    fake_trash.mkdir()
    result = make_result(source)

    def move_to_fake_trash(path: str) -> None:
        photo = Path(path)
        photo.rename(fake_trash / photo.name)

    trash_outcome = move_selection_to_trash(
        result,
        ["second"],
        mover=move_to_fake_trash,
    )
    storage_outcome = move_selection_to_storage(
        result,
        ["first"],
        destination,
    )

    assert trash_outcome["failures"] == []
    assert trash_outcome["moved"] == [str(source / "second.jpg")]
    assert (fake_trash / "second.jpg").read_bytes() == b"second"
    assert storage_outcome["failures"] == []
    assert storage_outcome["moved"] == [
        {
            "source": str(source / "first.jpg"),
            "destination": str(destination / "Photos" / "20240102" / "first.jpg"),
        }
    ]
    assert (destination / "Photos" / "20240102" / "first.jpg").read_bytes() == b"first"


def test_storage_selection_rejects_unknown_and_outside_files(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "archive"
    source.mkdir()
    destination.mkdir()
    result = make_result(source)

    with pytest.raises(ValueError, match="없는 사진"):
        validate_storage_selection(result, ["unknown"], destination)

    outside = tmp_path / "outside.jpg"
    outside.write_bytes(b"outside")
    result["groups"][0]["images"][0]["path"] = str(outside)
    with pytest.raises(ValueError, match="폴더 밖"):
        validate_storage_selection(result, ["first"], destination)


def test_storage_selection_accepts_files_from_all_selected_folders(tmp_path: Path) -> None:
    first_source = tmp_path / "first-source"
    second_source = tmp_path / "second-source"
    destination = tmp_path / "archive"
    first_source.mkdir()
    second_source.mkdir()
    destination.mkdir()
    result = make_result(first_source)
    second_photo = second_source / "second.jpg"
    second_photo.write_bytes(b"second source")
    result["folder"] = str(first_source)
    result["folders"] = [str(first_source), str(second_source)]
    result["groups"][0]["images"][1]["path"] = str(second_photo)

    _, images = validate_storage_selection(result, ["second"], destination)

    assert images[0][1] == second_photo


def test_storage_directory_must_exist(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    result = make_result(source)

    with pytest.raises(NotADirectoryError, match="저장 디렉터리"):
        validate_storage_selection(result, ["first"], tmp_path / "missing")


def test_move_failure_reports_source_destination_and_reason(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "archive"
    source.mkdir()
    destination.mkdir()
    result = make_result(source)

    def fail_move(source_path: str, destination_path: str) -> None:
        raise PermissionError("permission denied")

    outcome = move_selection_to_storage(
        result,
        ["first"],
        destination,
        mover=fail_move,
    )

    assert outcome["moved"] == []
    assert outcome["failures"] == [
        {
            "path": str(source / "first.jpg"),
            "destination": str(destination / "Photos" / "20240102" / "first.jpg"),
            "reason": "permission denied",
        }
    ]
    assert (source / "first.jpg").is_file()


def test_missing_file_does_not_stop_other_storage_moves(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "archive"
    source.mkdir()
    destination.mkdir()
    result = make_result(source)
    (source / "first.jpg").unlink()

    outcome = move_selection_to_storage(result, ["first", "second"], destination)

    assert outcome["moved"] == [
        {
            "source": str(source / "second.jpg"),
            "destination": str(destination / "Photos" / "20240304" / "second.jpg"),
        }
    ]
    assert outcome["failures"] == [
        {
            "path": str(source / "first.jpg"),
            "reason": "파일을 찾을 수 없습니다: first.jpg",
        }
    ]
    assert (destination / "Photos" / "20240304" / "second.jpg").read_bytes() == b"second"


def test_cross_filesystem_move_does_not_copy_unsupported_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "archive"
    source.mkdir()
    destination.mkdir()
    result = make_result(source)

    def reject_rename(source_path: str, destination_path: str) -> None:
        raise OSError(errno.EXDEV, "cross-device link", destination_path)

    def reject_metadata(*args: object, **kwargs: object) -> None:
        raise OSError(errno.EINVAL, "invalid argument")

    monkeypatch.setattr(shutil.os, "rename", reject_rename)
    monkeypatch.setattr(shutil, "copystat", reject_metadata)

    outcome = move_selection_to_storage(result, ["first"], destination)

    target = destination / "Photos" / "20240102" / "first.jpg"
    assert outcome["failures"] == []
    assert outcome["moved"] == [
        {"source": str(source / "first.jpg"), "destination": str(target)}
    ]
    assert not (source / "first.jpg").exists()
    assert target.read_bytes() == b"first"
