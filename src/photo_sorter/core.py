from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, datetime
from functools import lru_cache
import hashlib
import math
import os
from pathlib import Path
import re
import threading
import time
from typing import Callable, Iterable, Literal

import numpy as np
from PIL import Image, ImageOps


SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"}
SUPPORTED_VIDEO_EXTENSIONS = {
    ".3gp",
    ".avi",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".webm",
}
EXIF_TIME_KEYS = (36867, 36868, 306)  # DateTimeOriginal, DateTimeDigitized, DateTime
ProgressCallback = Callable[[int, int, str], None]
DateRangeCallback = Callable[[str | None, str | None], None]


@dataclass(frozen=True)
class ImageRecord:
    id: str
    path: Path
    captured_at: datetime
    time_source: str
    width: int
    height: int
    size_bytes: int
    phash: np.ndarray
    dhash: np.ndarray
    ahash: np.ndarray
    color_histogram: np.ndarray
    sharpness: float


@dataclass(frozen=True)
class SimilarityPair:
    left_id: str
    right_id: str
    gap_seconds: float
    similarity: float


def discover_images(folder: Path, include_subfolders: bool = True) -> list[Path]:
    candidates = folder.rglob("*") if include_subfolders else folder.iterdir()
    return sorted(
        (
            path
            for path in candidates
            if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
        ),
        key=lambda path: str(path).casefold(),
    )


def discover_videos(folder: Path, include_subfolders: bool = True) -> list[Path]:
    candidates = folder.rglob("*") if include_subfolders else folder.iterdir()
    return sorted(
        (
            path
            for path in candidates
            if path.is_file() and path.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS
        ),
        key=lambda path: str(path).casefold(),
    )


def delete_json_files(
    folder: Path,
    include_subfolders: bool = True,
) -> tuple[int, list[dict[str, str]]]:
    candidates = folder.rglob("*") if include_subfolders else folder.iterdir()
    paths = sorted(
        (path for path in candidates if path.is_file() and path.suffix.lower() == ".json"),
        key=lambda path: str(path).casefold(),
    )
    deleted = 0
    failures: list[dict[str, str]] = []
    for path in paths:
        try:
            path.unlink()
            deleted += 1
        except OSError as exc:
            failures.append({"path": str(path), "reason": str(exc)})
    return deleted, failures


def _parse_exif_datetime(value: object) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("\x00", "")
    for pattern in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y:%m:%d %H:%M"):
        try:
            return datetime.strptime(text[:19], pattern)
        except ValueError:
            continue
    return None


def _time_from_filename(stem: str) -> tuple[datetime, str] | None:
    epoch_match = re.search(r"(?<!\d)(1\d{12})(?!\d)", stem)
    if epoch_match:
        try:
            return datetime.fromtimestamp(int(epoch_match.group(1)) / 1000), "filename"
        except (OverflowError, OSError, ValueError):
            pass

    compact_match = re.search(r"(?<!\d)(20\d{6})[^\d]?(\d{6})(?!\d)", stem)
    if compact_match:
        try:
            return datetime.strptime("".join(compact_match.groups()), "%Y%m%d%H%M%S"), "filename"
        except ValueError:
            pass

    separated_match = re.search(
        r"(?<!\d)(20\d{2})[^\d]?(\d{2})[^\d]?(\d{2})[^\d]+(\d{2})[^\d]?(\d{2})[^\d]?(\d{2})(?!\d)",
        stem,
    )
    if separated_match:
        try:
            return datetime(*map(int, separated_match.groups())), "filename"
        except ValueError:
            pass

    return None


def capture_time(path: Path, image: Image.Image | None = None) -> tuple[datetime, str]:
    owns_image = image is None
    try:
        if image is None:
            image = Image.open(path)
        exif = image.getexif()
        for key in EXIF_TIME_KEYS:
            parsed = _parse_exif_datetime(exif.get(key))
            if parsed:
                return parsed, "exif"
    except (OSError, ValueError):
        pass
    finally:
        if owns_image and image is not None:
            image.close()

    filename_time = _time_from_filename(path.stem)
    if filename_time:
        return filename_time
    return datetime.fromtimestamp(path.stat().st_mtime), "modified"


@lru_cache(maxsize=1)
def _dct_matrix(size: int = 32) -> np.ndarray:
    positions = np.arange(size, dtype=np.float32)
    frequencies = positions[:, None]
    matrix = np.cos((math.pi / size) * (positions + 0.5) * frequencies)
    matrix[0] *= math.sqrt(1 / size)
    matrix[1:] *= math.sqrt(2 / size)
    return matrix.astype(np.float32)


def _fit_array(image: Image.Image, size: tuple[int, int], mode: str = "L") -> np.ndarray:
    fitted = ImageOps.fit(image.convert(mode), size, method=Image.Resampling.LANCZOS)
    return np.asarray(fitted, dtype=np.float32)


def _fingerprints(image: Image.Image) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, float]:
    gray32 = _fit_array(image, (32, 32), "L")
    dct = _dct_matrix() @ gray32 @ _dct_matrix().T
    low = dct[:8, :8].flatten()[1:]
    phash = low > np.median(low)

    gray_dhash = _fit_array(image, (9, 8), "L")
    dhash = (gray_dhash[:, 1:] > gray_dhash[:, :-1]).flatten()

    gray_ahash = _fit_array(image, (8, 8), "L")
    ahash = (gray_ahash > gray_ahash.mean()).flatten()

    rgb = _fit_array(image, (64, 64), "RGB").astype(np.uint8)
    quantized = (rgb // 64).astype(np.int16)
    histogram_index = quantized[:, :, 0] * 16 + quantized[:, :, 1] * 4 + quantized[:, :, 2]
    histogram = np.bincount(histogram_index.flatten(), minlength=64).astype(np.float32)
    histogram /= max(float(histogram.sum()), 1.0)

    gray64 = rgb.mean(axis=2)
    laplacian = (
        -4 * gray64[1:-1, 1:-1]
        + gray64[:-2, 1:-1]
        + gray64[2:, 1:-1]
        + gray64[1:-1, :-2]
        + gray64[1:-1, 2:]
    )
    sharpness = float(laplacian.var())
    return phash, dhash, ahash, histogram, sharpness


def analyze_image(
    path: Path,
    capture_info: tuple[datetime, str] | None = None,
) -> ImageRecord:
    resolved = path.resolve()
    stat = resolved.stat()
    captured_at, time_source = capture_info or (None, None)
    return _analyze_image_cached(
        str(resolved),
        stat.st_mtime_ns,
        stat.st_size,
        captured_at,
        time_source,
    )


@lru_cache(maxsize=10_000)
def _analyze_image_cached(
    path_text: str,
    modified_ns: int,
    size_bytes: int,
    captured_at: datetime | None,
    time_source: str | None,
) -> ImageRecord:
    del modified_ns  # The value participates in the cache key.
    path = Path(path_text)
    with Image.open(path) as source:
        if captured_at is None or time_source is None:
            captured_at, time_source = capture_time(path, source)
        original_width, original_height = source.size
        orientation = source.getexif().get(274, 1)
        source.draft("RGB", (160, 160))
        oriented = ImageOps.exif_transpose(source)
        phash, dhash, ahash, histogram, sharpness = _fingerprints(oriented)

    if orientation in {5, 6, 7, 8}:
        width, height = original_height, original_width
    else:
        width, height = original_width, original_height

    identity = hashlib.sha256(path_text.encode("utf-8")).hexdigest()[:16]
    return ImageRecord(
        id=identity,
        path=path,
        captured_at=captured_at,
        time_source=time_source,
        width=width,
        height=height,
        size_bytes=size_bytes,
        phash=phash,
        dhash=dhash,
        ahash=ahash,
        color_histogram=histogram,
        sharpness=sharpness,
    )


def clear_analysis_cache() -> int:
    entry_count = _analyze_image_cached.cache_info().currsize
    _analyze_image_cached.cache_clear()
    return entry_count


def similarity(left: ImageRecord, right: ImageRecord) -> float:
    phash_score = 1 - float(np.count_nonzero(left.phash != right.phash)) / left.phash.size
    dhash_score = 1 - float(np.count_nonzero(left.dhash != right.dhash)) / left.dhash.size
    ahash_score = 1 - float(np.count_nonzero(left.ahash != right.ahash)) / left.ahash.size
    histogram_score = float(np.sqrt(left.color_histogram * right.color_histogram).sum())
    combined = 0.5 * phash_score + 0.2 * dhash_score + 0.15 * ahash_score + 0.15 * histogram_score
    return round(max(0.0, min(1.0, combined)) * 100, 1)


def _quality_score(record: ImageRecord, records: Iterable[ImageRecord]) -> float:
    peers = list(records)
    max_pixels = max(item.width * item.height for item in peers) or 1
    max_bytes = max(item.size_bytes for item in peers) or 1
    sharpness_values = sorted(item.sharpness for item in peers)
    sharpness_cap = sharpness_values[max(0, math.ceil(len(sharpness_values) * 0.8) - 1)] or 1
    resolution = (record.width * record.height) / max_pixels
    file_size = record.size_bytes / max_bytes
    sharpness = min(record.sharpness / sharpness_cap, 1.0)
    return 0.55 * resolution + 0.25 * sharpness + 0.2 * file_size


def _matching_components(
    members: list[ImageRecord],
    pairs: list[SimilarityPair],
) -> list[list[ImageRecord]]:
    by_id = {member.id: member for member in members}
    parent = {member.id: member.id for member in members}

    def find(item: str) -> str:
        while parent[item] != item:
            parent[item] = parent[parent[item]]
            item = parent[item]
        return item

    for pair in pairs:
        left_root, right_root = find(pair.left_id), find(pair.right_id)
        if left_root != right_root:
            parent[right_root] = left_root

    grouped: dict[str, list[ImageRecord]] = {}
    for member in members:
        root = find(member.id)
        grouped.setdefault(root, []).append(by_id[member.id])
    return list(grouped.values())


def scan_folder(
    folder: Path,
    threshold: float = 88.0,
    time_window_seconds: int = 60,
    on_progress: ProgressCallback | None = None,
    max_workers: int | None = None,
    keeper_strategy: Literal["quality", "latest"] = "quality",
    include_subfolders: bool = True,
    day_limit: int | None = None,
    date_order: Literal["oldest", "newest"] = "oldest",
    on_date_range: DateRangeCallback | None = None,
    cleanup_json_files: bool = False,
) -> dict:
    started = time.perf_counter()
    folder = folder.expanduser().resolve()
    if not folder.is_dir():
        raise NotADirectoryError(f"폴더를 찾을 수 없습니다: {folder}")
    if not 0 <= threshold <= 100:
        raise ValueError("유사도 기준은 0에서 100 사이여야 합니다.")
    if time_window_seconds < 1:
        raise ValueError("시간 간격은 1초 이상이어야 합니다.")
    if keeper_strategy not in {"quality", "latest"}:
        raise ValueError("보존 사진 선택 방식이 올바르지 않습니다.")
    if day_limit is not None and day_limit < 1:
        raise ValueError("분석 날짜 수는 1일 이상이어야 합니다.")
    if date_order not in {"oldest", "newest"}:
        raise ValueError("날짜 정렬 방향이 올바르지 않습니다.")

    json_files_deleted = 0
    failures: list[dict[str, str]] = []
    if cleanup_json_files:
        json_files_deleted, json_failures = delete_json_files(
            folder,
            include_subfolders=include_subfolders,
        )
        failures.extend(json_failures)

    image_paths = discover_images(folder, include_subfolders=include_subfolders)
    video_paths = discover_videos(folder, include_subfolders=include_subfolders)
    paths = sorted(image_paths + video_paths, key=lambda path: str(path).casefold())
    records: list[ImageRecord] = []
    progress_lock = threading.Lock()
    workers = max_workers or min(8, max(2, (os.cpu_count() or 4)))
    capture_info_by_path: dict[Path, tuple[datetime, str]] = {}
    paths_to_analyze = paths
    available_days: set[date] = set()
    selected_capture_days: set[date] = set()

    if day_limit is not None:
        if on_progress:
            on_progress(0, len(paths), "indexing")
        completed = 0
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(capture_time, path): path for path in paths}
            for future in as_completed(futures):
                path = futures[future]
                try:
                    capture_info_by_path[path] = future.result()
                except Exception as exc:
                    failures.append({"path": str(path), "reason": str(exc)})
                with progress_lock:
                    completed += 1
                    if on_progress:
                        on_progress(completed, len(paths), "indexing")

        available_days = {
            captured_at.date()
            for captured_at, _ in capture_info_by_path.values()
        }
        ordered_days = sorted(available_days, reverse=date_order == "newest")
        selected_capture_days = set(ordered_days[:day_limit])
        paths_to_analyze = [
            path
            for path in paths
            if path in capture_info_by_path
            and capture_info_by_path[path][0].date() in selected_capture_days
        ]
        if on_date_range:
            on_date_range(
                min(selected_capture_days).isoformat() if selected_capture_days else None,
                max(selected_capture_days).isoformat() if selected_capture_days else None,
            )

    selected_image_paths = [
        path for path in paths_to_analyze if path.suffix.lower() in SUPPORTED_EXTENSIONS
    ]
    selected_video_paths = [
        path
        for path in paths_to_analyze
        if path.suffix.lower() in SUPPORTED_VIDEO_EXTENSIONS
    ]

    if on_progress:
        on_progress(0, len(selected_image_paths), "analyzing")

    completed = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(analyze_image, path, capture_info_by_path.get(path)): path
            for path in selected_image_paths
        }
        for future in as_completed(futures):
            path = futures[future]
            try:
                records.append(future.result())
            except Exception as exc:  # One damaged image must not abort the scan.
                failures.append({"path": str(path), "reason": str(exc)})
            with progress_lock:
                completed += 1
                if on_progress:
                    on_progress(completed, len(selected_image_paths), "analyzing")

    records.sort(key=lambda record: (record.captured_at, record.path.name.casefold(), str(record.path)))
    valid_video_paths: list[Path] = []
    for path in selected_video_paths:
        try:
            capture_info_by_path[path] = capture_info_by_path.get(path) or capture_time(path)
            valid_video_paths.append(path)
        except Exception as exc:
            failures.append({"path": str(path), "reason": str(exc)})
    if day_limit is None:
        selected_capture_days = {
            record.captured_at.date() for record in records
        } | {
            capture_info_by_path[path][0].date() for path in valid_video_paths
        }
        available_days = selected_capture_days
        if on_date_range:
            on_date_range(
                min(selected_capture_days).isoformat() if selected_capture_days else None,
                max(selected_capture_days).isoformat() if selected_capture_days else None,
            )
    pairs_in_window: list[SimilarityPair] = []
    matching_pairs: list[SimilarityPair] = []
    pair_total = max(len(records) - 1, 0)

    for index, (left, right) in enumerate(zip(records, records[1:]), start=1):
        gap = (right.captured_at - left.captured_at).total_seconds()
        if 0 <= gap <= time_window_seconds:
            pair = SimilarityPair(left.id, right.id, gap, similarity(left, right))
            pairs_in_window.append(pair)
            if pair.similarity >= threshold:
                matching_pairs.append(pair)
        if on_progress:
            on_progress(index, pair_total, "comparing")

    raw_groups = _matching_components(records, matching_pairs)
    groups: list[dict] = []

    for number, members in enumerate(raw_groups, start=1):
        members.sort(key=lambda record: (record.captured_at, record.path.name.casefold()))
        folder_count = len({member.path.parent for member in members})
        member_ids = {member.id for member in members}
        relevant_pairs = [
            pair
            for pair in matching_pairs
            if pair.left_id in member_ids and pair.right_id in member_ids
        ]
        components = _matching_components(members, relevant_pairs)
        similarity_matrix: dict[str, dict[str, float]] = {
            member.id: {member.id: 100.0} for member in members
        }
        for left_index, left in enumerate(members):
            for right in members[left_index + 1 :]:
                score = similarity(left, right)
                similarity_matrix[left.id][right.id] = score
                similarity_matrix[right.id][left.id] = score

        reference_by_id = {member.id: member.id for member in members}
        component_keepers: list[ImageRecord] = []
        for component in components:
            if keeper_strategy == "latest":
                _, component_keeper = max(
                    enumerate(component),
                    key=lambda indexed: (indexed[1].captured_at, indexed[0]),
                )
            else:
                _, component_keeper = max(
                    enumerate(component),
                    key=lambda indexed: (_quality_score(indexed[1], component), -indexed[0]),
                )
            component_keepers.append(component_keeper)
            for member in component:
                reference_by_id[member.id] = component_keeper.id

        keeper = component_keepers[0]
        serialized_images = []
        for member in members:
            reference_id = reference_by_id[member.id]
            score_to_keeper = similarity_matrix[reference_id][member.id]
            serialized_images.append(
                _serialize_record(
                    member,
                    folder,
                    score_to_keeper,
                    member.id != reference_id
                    and (keeper_strategy == "latest" or score_to_keeper >= threshold),
                    similarity_matrix[member.id],
                    reference_id,
                )
            )
        groups.append(
            {
                "id": f"group-{number}",
                "keep_id": keeper.id,
                "keep_ids": sorted({image["reference_id"] for image in serialized_images}),
                "images": serialized_images,
                "member_count": len(members),
                "folder_count": folder_count,
                "max_similarity": max(
                    (pair.similarity for pair in relevant_pairs),
                    default=100.0,
                ),
                "min_similarity": min(
                    (pair.similarity for pair in relevant_pairs),
                    default=100.0,
                ),
                "time_start": members[0].captured_at.isoformat(),
                "time_end": members[-1].captured_at.isoformat(),
            }
        )

    for path in valid_video_paths:
        captured_at, time_source = capture_info_by_path[path]
        identity = hashlib.sha256(str(path.resolve()).encode("utf-8")).hexdigest()[:16]
        stat = path.stat()
        video = {
            "id": identity,
            "name": path.name,
            "path": str(path.resolve()),
            "relative_path": path.resolve().relative_to(folder).as_posix(),
            "captured_at": captured_at.isoformat(),
            "time_source": time_source,
            "media_type": "video",
            "width": 0,
            "height": 0,
            "size_bytes": stat.st_size,
            "sharpness": 0.0,
            "similarity_to_keep": 100.0,
            "similarity_by_id": {identity: 100.0},
            "reference_id": identity,
            "marked": False,
        }
        groups.append(
            {
                "id": f"video-{identity}",
                "keep_id": identity,
                "keep_ids": [identity],
                "images": [video],
                "member_count": 1,
                "folder_count": 1,
                "max_similarity": 100.0,
                "min_similarity": 100.0,
                "time_start": captured_at.isoformat(),
                "time_end": captured_at.isoformat(),
            }
        )

    groups.sort(key=lambda group: group["time_start"])
    marked_images = [image for group in groups for image in group["images"] if image["marked"]]
    duration = time.perf_counter() - started
    return {
        "folder": str(folder),
        "threshold": threshold,
        "time_window_seconds": time_window_seconds,
        "keeper_strategy": keeper_strategy,
        "include_subfolders": include_subfolders,
        "cleanup_json_files": cleanup_json_files,
        "day_limit": day_limit,
        "date_order": date_order,
        "selected_date_start": (
            min(selected_capture_days).isoformat()
            if selected_capture_days
            else None
        ),
        "selected_date_end": (
            max(selected_capture_days).isoformat()
            if selected_capture_days
            else None
        ),
        "groups": groups,
        "failures": failures,
        "stats": {
            "found": len(paths),
            "selected": len(paths_to_analyze),
            "source_folders": len({path.parent for path in paths_to_analyze}),
            "available_days": len(available_days),
            "selected_days": len(selected_capture_days),
            "analyzed": len(records) + len(valid_video_paths),
            "videos": len(valid_video_paths),
            "json_files_deleted": json_files_deleted,
            "pairs_compared": len(pairs_in_window),
            "matched_pairs": len(matching_pairs),
            "groups": len(groups),
            "similar_groups": sum(group["member_count"] > 1 for group in groups),
            "singletons": sum(group["member_count"] == 1 for group in groups),
            "marked_count": len(marked_images),
            "marked_bytes": sum(image["size_bytes"] for image in marked_images),
            "duration_seconds": round(duration, 2),
        },
    }


def _serialize_record(
    record: ImageRecord,
    root: Path,
    score_to_keeper: float,
    marked: bool,
    similarity_by_id: dict[str, float],
    reference_id: str,
) -> dict:
    return {
        "id": record.id,
        "name": record.path.name,
        "path": str(record.path),
        "relative_path": record.path.relative_to(root).as_posix(),
        "captured_at": record.captured_at.isoformat(),
        "time_source": record.time_source,
        "media_type": "image",
        "width": record.width,
        "height": record.height,
        "size_bytes": record.size_bytes,
        "sharpness": round(record.sharpness, 1),
        "similarity_to_keep": score_to_keeper,
        "similarity_by_id": similarity_by_id,
        "reference_id": reference_id,
        "marked": marked,
    }
