import type { Photo, PhotoGroup, ScanResult } from "./appTypes";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function formatDateOnly(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}.${month}.${day}.`;
}

export function formatSelectedPeriod(start: string | null, end: string | null): string {
  if (!start || !end) return "선정된 파일 없음";
  const formattedStart = formatDateOnly(start);
  const formattedEnd = formatDateOnly(end);
  return start === end ? formattedStart : `${formattedStart} ~ ${formattedEnd}`;
}

export function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.detail || "요청을 처리하지 못했습니다.");
  }
  return payload as T;
}

export function imageUrl(scanId: string, imageId: string, size: "thumb" | "preview" = "preview") {
  return `/api/scans/${scanId}/images/${imageId}?size=${size}`;
}

export function clearCandidateMarks(result: ScanResult): ScanResult {
  return {
    ...result,
    groups: result.groups.map((group) => ({
      ...group,
      images: group.images.map((image) => ({ ...image, marked: false })),
    })),
  };
}

export function firstReviewPhoto(group: PhotoGroup | undefined): Photo | undefined {
  return group?.images.find((image) => image.marked) ?? group?.images[0];
}

export function filterReviewGroups(groups: PhotoGroup[], showSingletons: boolean): PhotoGroup[] {
  const photoGroups = groups.filter((group) => group.images.every((image) => image.media_type === "image"));
  return showSingletons ? photoGroups : photoGroups.filter((group) => group.images.length > 1);
}

export function removeMovedPhotos(result: ScanResult, movedPaths: string[]): ScanResult {
  const moved = new Set(movedPaths);
  const groups = result.groups.flatMap((group) => {
    const remaining = group.images.filter((image) => !moved.has(image.path));
    if (remaining.length === 0) return [];

    const remainingIds = new Set(remaining.map((image) => image.id));
    const replacementByReference = new Map<string, string>();
    for (const image of remaining) {
      if (!remainingIds.has(image.reference_id) && !replacementByReference.has(image.reference_id)) {
        replacementByReference.set(image.reference_id, image.id);
      }
    }

    const images = remaining.map((image) => {
      const referenceId = remainingIds.has(image.reference_id)
        ? image.reference_id
        : replacementByReference.get(image.reference_id) ?? remaining[0].id;
      return {
        ...image,
        reference_id: referenceId,
        similarity_to_keep: image.similarity_by_id[referenceId] ?? (image.id === referenceId ? 100 : image.similarity_to_keep),
        marked: image.marked,
      };
    });
    const keepIds = [...new Set(images.map((image) => image.reference_id))];
    return [{
      ...group,
      keep_id: remainingIds.has(group.keep_id) ? group.keep_id : keepIds[0],
      keep_ids: keepIds,
      images,
      member_count: images.length,
      folder_count: new Set(images.map((image) => image.relative_path.split("/").slice(0, -1).join("/"))).size,
      time_start: images[0].captured_at,
      time_end: images[images.length - 1].captured_at,
    }];
  });
  const marked = groups.flatMap((group) => group.images).filter((image) => image.marked);
  return {
    ...result,
    groups,
    stats: {
      ...result.stats,
      groups: groups.length,
      marked_count: marked.length,
      marked_bytes: marked.reduce((total, image) => total + image.size_bytes, 0),
    },
  };
}
