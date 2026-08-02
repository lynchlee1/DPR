from __future__ import annotations

from pathlib import Path
from typing import Callable, Iterable


TrashMover = Callable[[str], None]
CancelCallback = Callable[[], bool]


def validate_trash_selection(
    result: dict,
    image_ids: Iterable[str],
    allow_delete_all: bool = False,
) -> list[Path]:
    selected = set(image_ids)
    if not selected:
        raise ValueError("휴지통으로 보낼 사진을 선택해 주세요.")

    roots = [
        Path(folder).resolve()
        for folder in result.get("folders", [result["folder"]])
    ]
    known: dict[str, Path] = {}
    for group in result["groups"]:
        group_ids = {image["id"] for image in group["images"]}
        selected_in_group = group_ids & selected
        if not allow_delete_all and selected_in_group and selected_in_group == group_ids:
            raise ValueError("각 그룹에는 최소 한 장의 보관 사진이 남아 있어야 합니다.")
        for image in group["images"]:
            known[image["id"]] = Path(image["path"]).resolve()

    unknown = selected - known.keys()
    if unknown:
        raise ValueError("현재 분석 결과에 없는 사진이 포함되어 있습니다.")

    paths: list[Path] = []
    for image_id in selected:
        path = known[image_id]
        if not any(path == root or root in path.parents for root in roots):
            raise ValueError("선택한 폴더 밖의 파일은 이동할 수 없습니다.")
        paths.append(path)
    return sorted(paths, key=lambda path: str(path).casefold())


def move_selection_to_trash(
    result: dict,
    image_ids: Iterable[str],
    allow_delete_all: bool = False,
    mover: TrashMover | None = None,
    should_cancel: CancelCallback | None = None,
) -> dict:
    if mover is None:
        from send2trash import send2trash

        mover = send2trash

    paths = validate_trash_selection(result, image_ids, allow_delete_all=allow_delete_all)
    moved: list[str] = []
    failures: list[dict[str, str]] = []
    for path in paths:
        if should_cancel and should_cancel():
            return {"moved": moved, "failures": failures, "cancelled": True}
        if not path.is_file():
            failures.append(
                {"path": str(path), "reason": f"파일을 찾을 수 없습니다: {path.name}"}
            )
            continue
        try:
            mover(str(path))
            moved.append(str(path))
        except Exception as exc:
            failures.append({"path": str(path), "reason": str(exc)})
    return {"moved": moved, "failures": failures}
