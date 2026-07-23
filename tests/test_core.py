from datetime import datetime
from pathlib import Path
import os

import numpy as np
from PIL import Image, ImageDraw

from photo_sorter.core import analyze_image, capture_time, discover_images, scan_folder, similarity


def save_image(path: Path, color: tuple[int, int, int], exif_time: str | None = None) -> None:
    image = Image.new("RGB", (240, 180), color)
    draw = ImageDraw.Draw(image)
    draw.rectangle((36, 32, 204, 148), outline="white", width=8)
    draw.ellipse((76, 54, 164, 142), fill=(color[2], color[0], color[1]))
    exif = Image.Exif()
    if exif_time:
        exif[36867] = exif_time
    image.save(path, exif=exif)


def save_shifted_image(path: Path, center_x: int) -> None:
    image = Image.new("RGB", (300, 200), (28, 30, 34))
    draw = ImageDraw.Draw(image)
    draw.ellipse((center_x - 35, 65, center_x + 35, 135), fill=(220, 80, 60))
    draw.rectangle((20, 20, 75, 55), fill=(50, 130, 210))
    image.save(path, quality=92)


def test_capture_time_prefers_exif(tmp_path: Path) -> None:
    path = tmp_path / "1680258064650.jpg"
    save_image(path, (20, 50, 80), "2024:03:10 12:34:56")

    captured, source = capture_time(path)

    assert captured == datetime(2024, 3, 10, 12, 34, 56)
    assert source == "exif"


def test_capture_time_uses_filename_then_mtime(tmp_path: Path) -> None:
    filename_path = tmp_path / "Screenshot_20230426_214923_KakaoMap.jpg"
    save_image(filename_path, (30, 60, 90))
    fallback_path = tmp_path / "plain-name.jpg"
    save_image(fallback_path, (30, 60, 90))
    expected_mtime = datetime(2022, 7, 22, 9, 30, 15).timestamp()
    os.utime(fallback_path, (expected_mtime, expected_mtime))

    assert capture_time(filename_path) == (datetime(2023, 4, 26, 21, 49, 23), "filename")
    captured, source = capture_time(fallback_path)
    assert source == "modified"
    assert abs(captured.timestamp() - expected_mtime) < 1


def test_similarity_is_high_for_resized_copy_and_lower_for_different_image(tmp_path: Path) -> None:
    original_path = tmp_path / "original.jpg"
    copy_path = tmp_path / "copy.jpg"
    different_path = tmp_path / "different.jpg"
    save_image(original_path, (26, 93, 142))
    with Image.open(original_path) as image:
        image.resize((480, 360)).save(copy_path, quality=72)
    save_image(different_path, (170, 48, 35))

    original = analyze_image(original_path)
    copy = analyze_image(copy_path)
    different = analyze_image(different_path)

    assert similarity(original, copy) >= 94
    assert similarity(original, different) < 88


def test_scan_excludes_unrelated_chronological_neighbors_inside_one_minute(tmp_path: Path) -> None:
    save_image(tmp_path / "20240101_120000_first.jpg", (26, 93, 142))
    save_image(tmp_path / "20240101_120040_copy.jpg", (26, 93, 142))
    save_image(tmp_path / "20240101_120050_other.jpg", (170, 48, 35))
    save_image(tmp_path / "20240101_120200_late-copy.jpg", (26, 93, 142))

    result = scan_folder(tmp_path, threshold=88, time_window_seconds=60, max_workers=2)

    assert result["stats"]["found"] == 4
    assert result["stats"]["pairs_compared"] == 2
    assert result["stats"]["matched_pairs"] == 1
    assert result["stats"]["groups"] == 1
    assert [image["name"] for image in result["groups"][0]["images"]] == [
        "20240101_120000_first.jpg",
        "20240101_120040_copy.jpg",
    ]
    assert sum(image["marked"] for image in result["groups"][0]["images"]) == 1


def test_scan_splits_visual_matches_connected_only_by_capture_time(tmp_path: Path) -> None:
    save_image(tmp_path / "20240101_120000_blue-a.jpg", (26, 93, 142))
    save_image(tmp_path / "20240101_120010_blue-b.jpg", (26, 93, 142))
    save_image(tmp_path / "20240101_120020_red-a.jpg", (170, 48, 35))
    save_image(tmp_path / "20240101_120030_red-b.jpg", (170, 48, 35))

    result = scan_folder(tmp_path, threshold=88, time_window_seconds=60, max_workers=2)

    assert result["stats"]["groups"] == 2
    assert [
        [image["name"] for image in group["images"]]
        for group in result["groups"]
    ] == [
        ["20240101_120000_blue-a.jpg", "20240101_120010_blue-b.jpg"],
        ["20240101_120020_red-a.jpg", "20240101_120030_red-b.jpg"],
    ]


def test_scan_recurses_through_nested_photo_folders(tmp_path: Path) -> None:
    first_folder = tmp_path / "2023" / "trip"
    second_folder = tmp_path / "2024" / "favorites"
    first_folder.mkdir(parents=True)
    second_folder.mkdir(parents=True)
    save_image(first_folder / "20240101_120000_photo.jpg", (26, 93, 142))
    save_image(second_folder / "20240101_120030_photo.jpg", (26, 93, 142))
    (tmp_path / "2024" / "notes.txt").write_text("not an image")

    discovered = discover_images(tmp_path)
    result = scan_folder(tmp_path, threshold=88, time_window_seconds=60, max_workers=2)

    assert discovered == [
        first_folder / "20240101_120000_photo.jpg",
        second_folder / "20240101_120030_photo.jpg",
    ]
    assert result["stats"]["found"] == 2
    assert result["stats"]["source_folders"] == 2
    assert result["stats"]["groups"] == 1
    assert result["groups"][0]["folder_count"] == 2
    assert [image["relative_path"] for image in result["groups"][0]["images"]] == [
        "2023/trip/20240101_120000_photo.jpg",
        "2024/favorites/20240101_120030_photo.jpg",
    ]


def test_scan_can_exclude_nested_photo_folders(tmp_path: Path) -> None:
    nested_folder = tmp_path / "nested"
    nested_folder.mkdir()
    save_image(tmp_path / "20240101_120000_root.jpg", (26, 93, 142))
    save_image(tmp_path / "20240101_120030_root.jpg", (26, 93, 142))
    save_image(nested_folder / "20240101_120010_nested.jpg", (26, 93, 142))

    discovered = discover_images(tmp_path, include_subfolders=False)
    result = scan_folder(
        tmp_path,
        threshold=88,
        time_window_seconds=60,
        max_workers=2,
        include_subfolders=False,
    )

    assert discovered == [
        tmp_path / "20240101_120000_root.jpg",
        tmp_path / "20240101_120030_root.jpg",
    ]
    assert result["include_subfolders"] is False
    assert result["stats"]["found"] == 2
    assert result["stats"]["source_folders"] == 1
    assert [image["relative_path"] for image in result["groups"][0]["images"]] == [
        "20240101_120000_root.jpg",
        "20240101_120030_root.jpg",
    ]


def test_one_minute_chain_forms_one_five_photo_group(tmp_path: Path) -> None:
    for index, second in enumerate((0, 60, 120, 180, 240)):
        minute, remaining_second = divmod(second, 60)
        save_image(
            tmp_path / f"20240101_12{minute:02d}{remaining_second:02d}_{index}.jpg",
            (26, 93, 142),
        )

    result = scan_folder(tmp_path, threshold=88, time_window_seconds=60, max_workers=2)

    assert result["stats"]["groups"] == 1
    assert result["groups"][0]["member_count"] == 5
    assert len(result["groups"][0]["images"]) == 5
    assert sum(image["marked"] for image in result["groups"][0]["images"]) == 4


def test_transitive_group_only_marks_images_above_keeper_threshold(tmp_path: Path) -> None:
    save_shifted_image(tmp_path / "20240101_120000_a.jpg", 60)
    save_shifted_image(tmp_path / "20240101_120010_b.jpg", 65)
    save_shifted_image(tmp_path / "20240101_120020_c.jpg", 70)

    result = scan_folder(tmp_path, threshold=90, time_window_seconds=60, max_workers=2)

    assert result["stats"]["groups"] == 1
    group = result["groups"][0]
    assert len(group["images"]) == 3
    assert all(image["similarity_to_keep"] >= 90 for image in group["images"] if image["marked"])
    for image in group["images"]:
        assert image["similarity_by_id"][group["keep_id"]] == image["similarity_to_keep"]


def test_quick_scan_keeps_latest_photo_and_marks_the_rest(tmp_path: Path) -> None:
    for second in (0, 10, 20):
        save_image(
            tmp_path / f"20240101_1200{second:02d}.jpg",
            (26, 93, 142),
        )

    result = scan_folder(
        tmp_path,
        threshold=96,
        time_window_seconds=60,
        max_workers=2,
        keeper_strategy="latest",
    )

    group = result["groups"][0]
    assert group["keep_id"] == group["images"][-1]["id"]
    assert [image["marked"] for image in group["images"]] == [True, True, False]
    assert result["stats"]["marked_count"] == 2
