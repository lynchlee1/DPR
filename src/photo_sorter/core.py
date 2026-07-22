from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
import hashlib
import math
import os
from pathlib import Path
import re
import threading
import time
from typing import Callable, Iterable

import numpy as np
from PIL import Image, ImageOps


SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"}
EXIF_TIME_KEYS = (36867, 36868, 306)  # DateTimeOriginal, DateTimeDigitized, DateTime
ProgressCallback = Callable[[int, int, str], None]


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


def discover_images(folder: Path) -> list[Path]:
    return sorted(
        (
            path
            for path in folder.rglob("*")
            if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
        ),
        key=lambda path: str(path).casefold(),
    )


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


def analyze_image(path: Path) -> ImageRecord:
    resolved = path.resolve()
    stat = resolved.stat()
    return _analyze_image_cached(str(resolved), stat.st_mtime_ns, stat.st_size)


@lru_cache(maxsize=10_000)
def _analyze_image_cached(path_text: str, modified_ns: int, size_bytes: int) -> ImageRecord:
    del modified_ns  # The value participates in the cache key.
    path = Path(path_text)
    with Image.open(path) as source:
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

    identity = hashlib.sha1(path_text.encode("utf-8")).hexdigest()[:16]
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


def _time_groups(
    records: list[ImageRecord],
    pairs_in_window: list[SimilarityPair],
    matching_pairs: list[SimilarityPair],
) -> list[list[ImageRecord]]:
    if not records:
        return []

    within_window = {(pair.left_id, pair.right_id) for pair in pairs_in_window}
    matching = {(pair.left_id, pair.right_id) for pair in matching_pairs}
    groups: list[list[ImageRecord]] = []
    current = [records[0]]
    current_has_match = False

    for left, right in zip(records, records[1:]):
        link = (left.id, right.id)
        if link in within_window:
            current.append(right)
            current_has_match = current_has_match or link in matching
            continue

        if current_has_match:
            groups.append(current)
        current = [right]
        current_has_match = False

    if current_has_match:
        groups.append(current)
    return groups


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
    return [component for component in grouped.values() if len(component) > 1]


def scan_folder(
    folder: Path,
    threshold: float = 88.0,
    time_window_seconds: int = 60,
    on_progress: ProgressCallback | None = None,
    max_workers: int | None = None,
) -> dict:
    started = time.perf_counter()
    folder = folder.expanduser().resolve()
    if not folder.is_dir():
        raise NotADirectoryError(f"폴더를 찾을 수 없습니다: {folder}")
    if not 0 <= threshold <= 100:
        raise ValueError("유사도 기준은 0에서 100 사이여야 합니다.")
    if time_window_seconds < 1:
        raise ValueError("시간 간격은 1초 이상이어야 합니다.")

    paths = discover_images(folder)
    if on_progress:
        on_progress(0, len(paths), "analyzing")

    records: list[ImageRecord] = []
    failures: list[dict[str, str]] = []
    progress_lock = threading.Lock()
    completed = 0
    workers = max_workers or min(8, max(2, (os.cpu_count() or 4)))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(analyze_image, path): path for path in paths}
        for future in as_completed(futures):
            path = futures[future]
            try:
                records.append(future.result())
            except Exception as exc:  # One damaged image must not abort the scan.
                failures.append({"path": str(path), "reason": str(exc)})
            with progress_lock:
                completed += 1
                if on_progress:
                    on_progress(completed, len(paths), "analyzing")

    records.sort(key=lambda record: (record.captured_at, record.path.name.casefold(), str(record.path)))
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

    raw_groups = _time_groups(records, pairs_in_window, matching_pairs)
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
                    member.id != reference_id and score_to_keeper >= threshold,
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
                "max_similarity": max(pair.similarity for pair in relevant_pairs),
                "min_similarity": min(pair.similarity for pair in relevant_pairs),
                "time_start": members[0].captured_at.isoformat(),
                "time_end": members[-1].captured_at.isoformat(),
            }
        )

    groups.sort(key=lambda group: group["time_start"])
    marked_images = [image for group in groups for image in group["images"] if image["marked"]]
    duration = time.perf_counter() - started
    return {
        "folder": str(folder),
        "threshold": threshold,
        "time_window_seconds": time_window_seconds,
        "groups": groups,
        "failures": failures,
        "stats": {
            "found": len(paths),
            "source_folders": len({path.parent for path in paths}),
            "analyzed": len(records),
            "pairs_compared": len(pairs_in_window),
            "matched_pairs": len(matching_pairs),
            "groups": len(groups),
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
        "width": record.width,
        "height": record.height,
        "size_bytes": record.size_bytes,
        "sharpness": round(record.sharpness, 1),
        "similarity_to_keep": score_to_keeper,
        "similarity_by_id": similarity_by_id,
        "reference_id": reference_id,
        "marked": marked,
    }
