from pathlib import Path

import pytest

from photo_sorter.trash import move_selection_to_trash, validate_trash_selection


def make_result(tmp_path: Path) -> dict:
    first = tmp_path / "first.jpg"
    second = tmp_path / "second.jpg"
    first.write_bytes(b"first")
    second.write_bytes(b"second")
    return {
        "folder": str(tmp_path),
        "groups": [
            {
                "images": [
                    {"id": "first", "path": str(first)},
                    {"id": "second", "path": str(second)},
                ]
            }
        ],
    }


def test_selection_must_leave_one_image_per_group(tmp_path: Path) -> None:
    result = make_result(tmp_path)

    with pytest.raises(ValueError, match="최소 한 장"):
        validate_trash_selection(result, ["first", "second"])


def test_explicit_delete_all_allows_an_empty_group(tmp_path: Path) -> None:
    result = make_result(tmp_path)

    paths = validate_trash_selection(result, ["first", "second"], allow_delete_all=True)

    assert paths == [tmp_path / "first.jpg", tmp_path / "second.jpg"]


def test_unknown_and_outside_paths_are_rejected(tmp_path: Path) -> None:
    result = make_result(tmp_path)
    with pytest.raises(ValueError, match="없는 사진"):
        validate_trash_selection(result, ["unknown"])

    outside = tmp_path.parent / "outside.jpg"
    outside.write_bytes(b"outside")
    result["groups"][0]["images"][0]["path"] = str(outside)
    with pytest.raises(ValueError, match="폴더 밖"):
        validate_trash_selection(result, ["first"])


def test_selection_accepts_files_from_all_selected_folders(tmp_path: Path) -> None:
    first_source = tmp_path / "first-source"
    second_source = tmp_path / "second-source"
    first_source.mkdir()
    second_source.mkdir()
    result = make_result(first_source)
    second_photo = second_source / "second.jpg"
    second_photo.write_bytes(b"second source")
    result["folder"] = str(first_source)
    result["folders"] = [str(first_source), str(second_source)]
    result["groups"][0]["images"][1]["path"] = str(second_photo)

    paths = validate_trash_selection(result, ["second"])

    assert paths == [second_photo]


def test_move_uses_injected_trash_mover(tmp_path: Path) -> None:
    result = make_result(tmp_path)
    moved: list[str] = []

    outcome = move_selection_to_trash(result, ["second"], mover=moved.append)

    assert outcome == {"moved": [str(tmp_path / "second.jpg")], "failures": []}
    assert moved == [str(tmp_path / "second.jpg")]


def test_trash_move_stops_between_files(tmp_path: Path) -> None:
    result = make_result(tmp_path)
    moved: list[str] = []

    outcome = move_selection_to_trash(
        result,
        ["first", "second"],
        allow_delete_all=True,
        mover=moved.append,
        should_cancel=lambda: len(moved) == 1,
    )

    assert outcome == {
        "moved": [str(tmp_path / "first.jpg")],
        "failures": [],
        "cancelled": True,
    }


def test_move_can_explicitly_trash_every_image_in_a_group(tmp_path: Path) -> None:
    result = make_result(tmp_path)
    moved: list[str] = []

    outcome = move_selection_to_trash(
        result,
        ["first", "second"],
        allow_delete_all=True,
        mover=moved.append,
    )

    assert outcome["failures"] == []
    assert moved == [str(tmp_path / "first.jpg"), str(tmp_path / "second.jpg")]


def test_single_photo_group_can_be_trashed_after_explicit_confirmation(tmp_path: Path) -> None:
    result = make_result(tmp_path)
    result["groups"][0]["images"] = [result["groups"][0]["images"][0]]
    moved: list[str] = []

    outcome = move_selection_to_trash(
        result,
        ["first"],
        allow_delete_all=True,
        mover=moved.append,
    )

    assert outcome == {"moved": [str(tmp_path / "first.jpg")], "failures": []}
    assert moved == [str(tmp_path / "first.jpg")]


def test_nested_photo_is_a_valid_trash_target(tmp_path: Path) -> None:
    nested = tmp_path / "album" / "day-one"
    nested.mkdir(parents=True)
    nested_photo = nested / "second.jpg"
    nested_photo.write_bytes(b"nested")
    result = make_result(tmp_path)
    result["groups"][0]["images"][1]["path"] = str(nested_photo)
    moved: list[str] = []

    outcome = move_selection_to_trash(result, ["second"], mover=moved.append)

    assert outcome == {"moved": [str(nested_photo)], "failures": []}
    assert moved == [str(nested_photo)]


def test_missing_file_does_not_stop_other_trash_moves(tmp_path: Path) -> None:
    result = make_result(tmp_path)
    (tmp_path / "first.jpg").unlink()
    moved: list[str] = []

    outcome = move_selection_to_trash(
        result,
        ["first", "second"],
        allow_delete_all=True,
        mover=moved.append,
    )

    assert moved == [str(tmp_path / "second.jpg")]
    assert outcome == {
        "moved": [str(tmp_path / "second.jpg")],
        "failures": [
            {
                "path": str(tmp_path / "first.jpg"),
                "reason": "파일을 찾을 수 없습니다: first.jpg",
            }
        ],
    }
