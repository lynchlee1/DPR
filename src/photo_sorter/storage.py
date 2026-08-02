from __future__ import annotations

from datetime import datetime
import hashlib
import os
from pathlib import Path
import shutil
from typing import Callable, Iterable


StorageMover = Callable[[str, str], object]
CancelCallback = Callable[[], bool]


def inspect_source_directories(result: dict) -> dict:
    """Count every file still present under the selected source directories."""
    roots = [
        Path(folder).expanduser().resolve()
        for folder in result.get("folders", [result["folder"]])
    ]
    directories: list[dict] = []
    unique_files: set[Path] = set()
    total_bytes = 0
    errors: list[dict[str, str]] = []

    for root in roots:
        file_count = 0
        size_bytes = 0
        directory_errors: list[str] = []
        if not root.is_dir():
            message = "검사 대상 디렉터리를 찾을 수 없습니다."
            directory_errors.append(message)
            errors.append({"path": str(root), "reason": message})
        else:
            def record_walk_error(error: OSError) -> None:
                path = str(error.filename or root)
                reason = str(error)
                directory_errors.append(reason)
                errors.append({"path": path, "reason": reason})

            for current, _, filenames in os.walk(root, onerror=record_walk_error):
                for filename in filenames:
                    path = Path(current, filename)
                    try:
                        file_size = path.stat(follow_symlinks=False).st_size
                    except OSError as exc:
                        reason = str(exc)
                        directory_errors.append(reason)
                        errors.append({"path": str(path), "reason": reason})
                        continue
                    file_count += 1
                    size_bytes += file_size
                    resolved_path = path.resolve()
                    if resolved_path not in unique_files:
                        unique_files.add(resolved_path)
                        total_bytes += file_size

        directories.append({
            "path": str(root),
            "file_count": file_count,
            "size_bytes": size_bytes,
            "error": directory_errors[0] if directory_errors else None,
        })

    return {
        "is_empty": not errors and not unique_files,
        "file_count": len(unique_files),
        "size_bytes": total_bytes,
        "directories": directories,
        "errors": errors,
    }


def _move_file(source: str, destination: str) -> object:
    # copy2 can fail while applying unsupported metadata to ExFAT after copying the data.
    return shutil.move(source, destination, copy_function=shutil.copyfile)


def validate_storage_selection(
    result: dict,
    image_ids: Iterable[str],
    destination: Path,
) -> tuple[Path, list[tuple[dict, Path]]]:
    selected = set(image_ids)
    if not selected:
        raise ValueError("보관 위치로 옮길 사진을 선택해 주세요.")

    destination = destination.expanduser().resolve()
    if not destination.is_dir():
        raise NotADirectoryError(f"저장 디렉터리를 찾을 수 없습니다: {destination}")

    roots = [
        Path(folder).resolve()
        for folder in result.get("folders", [result["folder"]])
    ]
    known: dict[str, dict] = {
        image["id"]: image
        for group in result["groups"]
        for image in group["images"]
    }
    unknown = selected - known.keys()
    if unknown:
        raise ValueError("현재 분석 결과에 없는 사진이 포함되어 있습니다.")

    images: list[tuple[dict, Path]] = []
    for image_id in selected:
        image = known[image_id]
        path = Path(image["path"]).resolve()
        if not any(path == root or root in path.parents for root in roots):
            raise ValueError("선택한 폴더 밖의 파일은 이동할 수 없습니다.")
        images.append((image, path))

    images.sort(key=lambda item: str(item[1]).casefold())
    return destination, images


def _unique_destination(path: Path) -> Path:
    if not path.exists():
        return path
    for number in range(1, 10_000):
        candidate = path.with_name(f"{path.stem} ({number}){path.suffix}")
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"같은 이름의 파일이 너무 많습니다: {path.name}")


def _sha256(path: Path) -> bytes:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def _files_have_same_hash(first: Path, second: Path) -> bool:
    return (
        first.stat().st_size == second.stat().st_size
        and _sha256(first) == _sha256(second)
    )


def move_selection_to_storage(
    result: dict,
    image_ids: Iterable[str],
    destination: Path,
    mover: StorageMover | None = None,
    should_cancel: CancelCallback | None = None,
) -> dict:
    destination, images = validate_storage_selection(result, image_ids, destination)
    mover = mover or _move_file
    moved: list[dict[str, str]] = []
    failures: list[dict[str, str]] = []
    planned: list[tuple[Path, Path]] = []

    for image, source in images:
        if not source.is_file():
            failures.append(
                {"path": str(source), "reason": f"파일을 찾을 수 없습니다: {source.name}"}
            )
            continue
        try:
            captured_at = datetime.fromisoformat(image["captured_at"])
            target_folder = destination / "Photos" / captured_at.strftime("%Y%m%d")
            planned.append((source, target_folder))
        except Exception as exc:
            failures.append({"path": str(source), "reason": str(exc)})

    for target_folder in sorted({folder for _, folder in planned}):
        try:
            target_folder.mkdir(parents=True, exist_ok=True)
            if not os.access(target_folder, os.W_OK):
                raise PermissionError("쓰기 권한이 없습니다.")
        except OSError as exc:
            raise PermissionError(
                f"촬영일 저장 폴더를 만들거나 쓸 수 없습니다: {target_folder} ({exc})"
            ) from exc

    for source, target_folder in planned:
        if should_cancel and should_cancel():
            return {"moved": moved, "failures": failures, "cancelled": True}
        target: Path | None = None
        try:
            expected_target = (target_folder / source.name).resolve()
            if source == expected_target:
                target = expected_target
            elif expected_target.is_file() and _files_have_same_hash(
                source, expected_target
            ):
                target = expected_target
                expected_target.unlink()
                mover(str(source), str(target))
            else:
                target = _unique_destination(expected_target)
                mover(str(source), str(target))
            moved.append({"source": str(source), "destination": str(target)})
        except Exception as exc:
            failure = {"path": str(source), "reason": str(exc)}
            if target is not None:
                failure["destination"] = str(target)
            failures.append(failure)

    return {"moved": moved, "failures": failures}
