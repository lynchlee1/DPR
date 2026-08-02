import {
  ArrowCounterClockwise,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CaretDown,
  Check,
  CheckCircle,
  Database,
  FolderOpen,
  ImageSquare,
  Info,
  Keyboard,
  Lightning,
  MagnifyingGlass,
  Question,
  ShieldCheck,
  Sparkle,
  Stop,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { GuideOverlay, type GuideState } from "./GuideOverlay";

type ScanStatus = "queued" | "running" | "cancelling" | "cancelled" | "complete" | "error";
type AnalysisMode = "standard" | "quick";
type DateOrder = "oldest" | "newest";

const DEFAULT_QUICK_THRESHOLD = 96;
const SETUP_GUIDE_KEY = "photo-sorter-setup-guide-v1";
const REVIEW_GUIDE_KEY = "photo-sorter-review-guide-v1";
const SHOW_SINGLETONS_KEY = "photo-sorter-show-singletons";
const CLEANUP_JSON_KEY = "photo-sorter-cleanup-json";
const ARROW_REPEAT_INTERVAL_KEY = "photo-sorter-arrow-repeat-interval";
const DEFAULT_ARROW_REPEAT_INTERVAL = 250;

type Photo = {
  id: string;
  name: string;
  path: string;
  relative_path: string;
  captured_at: string;
  time_source: "exif" | "filename" | "modified";
  media_type: "image" | "video";
  width: number;
  height: number;
  size_bytes: number;
  sharpness: number;
  similarity_to_keep: number;
  similarity_by_id: Record<string, number>;
  reference_id: string;
  marked: boolean;
};

type PhotoGroup = {
  id: string;
  keep_id: string;
  keep_ids: string[];
  images: Photo[];
  member_count: number;
  folder_count: number;
  max_similarity: number;
  min_similarity: number;
  time_start: string;
  time_end: string;
};

type ScanResult = {
  folder: string;
  threshold: number;
  time_window_seconds: number;
  keeper_strategy: "quality" | "latest";
  include_subfolders: boolean;
  cleanup_json_files: boolean;
  day_limit: number | null;
  date_order: DateOrder;
  selected_date_start: string | null;
  selected_date_end: string | null;
  groups: PhotoGroup[];
  failures: { path: string; reason: string }[];
  stats: {
    found: number;
    selected: number;
    source_folders: number;
    available_days: number;
    selected_days: number;
    analyzed: number;
    videos: number;
    json_files_deleted: number;
    pairs_compared: number;
    matched_pairs: number;
    groups: number;
    similar_groups: number;
    singletons: number;
    marked_count: number;
    marked_bytes: number;
    duration_seconds: number;
  };
};

type Session = {
  id: string;
  folder: string;
  threshold: number;
  time_window_seconds: number;
  mode: AnalysisMode;
  include_subfolders: boolean;
  cleanup_json_files: boolean;
  day_limit: number | null;
  date_order: DateOrder;
  selected_date_start: string | null;
  selected_date_end: string | null;
  status: ScanStatus;
  phase: "queued" | "indexing" | "analyzing" | "comparing" | "cancelling" | "cancelled" | "complete" | "error";
  completed: number;
  total: number;
  result: ScanResult | null;
  error: string | null;
  reused?: boolean;
};

type CleanupOutcome = {
  moved: string[];
  failures: { path: string; reason: string }[];
  cancelled?: boolean;
};

type StorageOutcome = {
  moved: { source: string; destination: string }[];
  failures: { path: string; destination?: string; reason: string }[];
  cancelled?: boolean;
};

type CalculationCache = {
  analysis_entry_count: number;
  analysis_groups: { name: string; path: string; entry_count: number }[];
  preview_entry_count: number;
  session_count: number;
};

function formatBytes(bytes: number): string {
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDateOnly(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}.${month}.${day}.`;
}

function formatSelectedPeriod(start: string | null, end: string | null): string {
  if (!start || !end) return "선정된 파일 없음";
  const formattedStart = formatDateOnly(start);
  const formattedEnd = formatDateOnly(end);
  return start === end ? formattedStart : `${formattedStart} ~ ${formattedEnd}`;
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
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

function imageUrl(scanId: string, imageId: string, size: "thumb" | "preview" = "preview") {
  return `/api/scans/${scanId}/images/${imageId}?size=${size}`;
}

function clearCandidateMarks(result: ScanResult): ScanResult {
  return {
    ...result,
    groups: result.groups.map((group) => ({
      ...group,
      images: group.images.map((image) => ({ ...image, marked: false })),
    })),
  };
}

function firstReviewPhoto(group: PhotoGroup | undefined): Photo | undefined {
  return group?.images.find((image) => image.marked) ?? group?.images[0];
}

function filterReviewGroups(groups: PhotoGroup[], showSingletons: boolean): PhotoGroup[] {
  const photoGroups = groups.filter((group) => group.images.every((image) => image.media_type === "image"));
  return showSingletons ? photoGroups : photoGroups.filter((group) => group.images.length > 1);
}

function removeMovedPhotos(result: ScanResult, movedPaths: string[]): ScanResult {
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

export function App() {
  const [folder, setFolder] = useState(() => localStorage.getItem("photo-sorter-folder") || "");
  const [destination, setDestination] = useState(() => localStorage.getItem("photo-sorter-destination") || "");
  const [threshold, setThreshold] = useState(88);
  const [quickThreshold, setQuickThreshold] = useState(DEFAULT_QUICK_THRESHOLD);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("standard");
  const [includeSubfolders, setIncludeSubfolders] = useState(
    () => localStorage.getItem("photo-sorter-include-subfolders") !== "false",
  );
  const [cleanupJsonFiles, setCleanupJsonFiles] = useState(
    () => localStorage.getItem(CLEANUP_JSON_KEY) === "true",
  );
  const [dayLimit, setDayLimit] = useState(() => localStorage.getItem("photo-sorter-day-limit") || "");
  const [dateOrder, setDateOrder] = useState<DateOrder>(
    () => localStorage.getItem("photo-sorter-date-order") === "newest" ? "newest" : "oldest",
  );
  const [showSingletons, setShowSingletons] = useState(
    () => localStorage.getItem(SHOW_SINGLETONS_KEY) !== "false",
  );
  const [arrowRepeatInterval, setArrowRepeatInterval] = useState(() => {
    const stored = Number(localStorage.getItem(ARROW_REPEAT_INTERVAL_KEY));
    return Number.isFinite(stored) && stored >= 100 && stored <= 1000
      ? stored
      : DEFAULT_ARROW_REPEAT_INTERVAL;
  });
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [selectedGroupIndex, setSelectedGroupIndex] = useState(0);
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isPickingDestination, setIsPickingDestination] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const [isCacheDialogOpen, setIsCacheDialogOpen] = useState(false);
  const [isCacheLoading, setIsCacheLoading] = useState(false);
  const [calculationCache, setCalculationCache] = useState<CalculationCache | null>(null);
  const [isTrashDialogOpen, setIsTrashDialogOpen] = useState(false);
  const [trashThroughGroupIndex, setTrashThroughGroupIndex] = useState<number | null>(null);
  const [isTrashing, setIsTrashing] = useState(false);
  const [cleanupOutcome, setCleanupOutcome] = useState<CleanupOutcome | null>(null);
  const [isStorageDialogOpen, setIsStorageDialogOpen] = useState(false);
  const [isStoring, setIsStoring] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [storageOutcome, setStorageOutcome] = useState<StorageOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guide, setGuide] = useState<GuideState | null>(() =>
    localStorage.getItem(SETUP_GUIDE_KEY) ? null : { kind: "setup", step: 0 },
  );
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const lastArrowNavigationAtRef = useRef(0);

  const isScanning = session?.status === "queued" || session?.status === "running" || session?.status === "cancelling";
  const isMoving = isStoring || isTrashing;
  const visibleGroups = useMemo(
    () => filterReviewGroups(result?.groups ?? [], showSingletons),
    [result, showSingletons],
  );
  const currentGroup = visibleGroups[selectedGroupIndex] ?? null;
  const selectedPhoto =
    currentGroup?.images.find((image) => image.id === selectedPhotoId) ??
    firstReviewPhoto(currentGroup ?? undefined) ??
    null;

  const markedPhotos = useMemo(
    () => visibleGroups.flatMap((group) => group.images).filter((image) => image.marked),
    [visibleGroups],
  );
  const keptPhotos = useMemo(
    () => (result?.groups ?? []).flatMap((group) => group.images).filter((image) => !image.marked),
    [result],
  );
  const hiddenVideos = useMemo(
    () => (result?.groups ?? []).flatMap((group) => group.images).filter((image) => image.media_type === "video"),
    [result],
  );
  const hiddenSingletonPhotoCount = (result?.groups ?? []).filter(
    (group) => group.images.length === 1 && group.images[0].media_type === "image",
  ).length;
  const markedBytes = markedPhotos.reduce((total, image) => total + image.size_bytes, 0);
  const keptBytes = keptPhotos.reduce((total, image) => total + image.size_bytes, 0);
  const groupsInTrashScope = visibleGroups.length
    ? trashThroughGroupIndex === null
      ? visibleGroups
      : visibleGroups.slice(0, trashThroughGroupIndex + 1)
    : [];
  const pendingTrashPhotos = groupsInTrashScope.flatMap((group) => group.images).filter((image) => image.marked);
  const pendingTrashBytes = pendingTrashPhotos.reduce((total, image) => total + image.size_bytes, 0);
  const fullyMarkedGroupCount = groupsInTrashScope.filter(
    (group) => group.images.length > 0 && group.images.every((image) => image.marked),
  ).length;
  const throughCurrentMarkedPhotos =
    visibleGroups.slice(0, selectedGroupIndex + 1).flatMap((group) => group.images).filter((image) => image.marked);
  const throughCurrentMarkedBytes = throughCurrentMarkedPhotos.reduce((total, image) => total + image.size_bytes, 0);
  const activeThreshold = analysisMode === "quick" ? quickThreshold : threshold;
  const isDayLimitValid = dayLimit === "" || (/^\d+$/.test(dayLimit) && Number(dayLimit) >= 1);
  const advancedSummary = !isDayLimitValid
    ? "분석 날짜 수를 확인하세요"
    : [
        includeSubfolders ? "하위 폴더 포함" : "현재 폴더만",
        showSingletons ? "단독 사진 표시" : "단독 사진 숨김",
        cleanupJsonFiles ? "JSON 청소" : "JSON 유지",
        `방향키 ${arrowRepeatInterval}ms`,
        dayLimit ? `${dateOrder === "oldest" ? "오래된 날부터" : "최신 날부터"} ${dayLimit}일` : "전체 기간",
        `유사도 ${activeThreshold}%`,
      ].join(", ");

  useEffect(() => {
    if (!session || session.status === "complete" || session.status === "error" || session.status === "cancelled") return;
    const timer = window.setInterval(async () => {
      try {
        const next = await api<Session>(`/api/scans/${session.id}`);
        setSession(next);
        if (next.status === "complete" && next.result) {
          const initialResult = next.mode === "quick" ? next.result : clearCandidateMarks(next.result);
          const initialGroups = filterReviewGroups(initialResult.groups, showSingletons);
          setResult(initialResult);
          setSelectedGroupIndex(0);
          setSelectedPhotoId(firstReviewPhoto(initialGroups[0])?.id ?? null);
        }
        if (next.status === "error") setError(next.error || "사진을 분석하는 중 오류가 발생했습니다.");
        if (next.status === "cancelled") {
          setSession(null);
          setIsCancelling(false);
          setResetNotice("사진 분석을 중단했습니다.");
        }
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : "분석 상태를 확인하지 못했습니다.");
      }
    }, 350);
    return () => window.clearInterval(timer);
  }, [session?.id, session?.status, showSingletons]);

  useEffect(() => {
    if (!session || session.mode !== "quick" || !result) return;
    const preloaders = visibleGroups
      .slice(selectedGroupIndex + 1, selectedGroupIndex + 3)
      .flatMap((group) => group.images)
      .map((image) => {
        const preloader = new Image();
        preloader.decoding = "async";
        preloader.src = imageUrl(session.id, image.id);
        return preloader;
      });
    return () => {
      preloaders.forEach((preloader) => {
        preloader.onload = null;
        preloader.onerror = null;
      });
    };
  }, [session?.id, session?.mode, result, selectedGroupIndex, visibleGroups]);

  useEffect(() => {
    if (!visibleGroups.length || guide || localStorage.getItem(REVIEW_GUIDE_KEY)) return;
    const timer = window.setTimeout(() => setGuide({ kind: "review", step: 0 }), 0);
    return () => window.clearTimeout(timer);
  }, [visibleGroups.length, guide]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!result || isTrashDialogOpen || isStorageDialogOpen || guide) return;
      const isArrowNavigation = event.key === "ArrowRight" || event.key === "ArrowLeft";
      if (event.repeat && !isArrowNavigation) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      const key = event.key.toLowerCase();
      if (!event.shiftKey && /^[1-9]$/.test(key)) {
        const photoIndex = Number(key) - 1;
        const photo = currentGroup?.images[photoIndex];
        if (photo) {
          event.preventDefault();
          setSelectedPhotoId(photo.id);
          updateCurrentGroup((group) => ({
            ...group,
            images: group.images.map((image) => ({ ...image, marked: image.id !== photo.id })),
          }));
        }
        return;
      }
      if (event.shiftKey && (key === "a" || key === "n")) {
        event.preventDefault();
        markCurrentGroup(key === "a");
        return;
      }
      if (event.shiftKey && (key === "d" || key === "s")) {
        event.preventDefault();
        if (key === "d" && selectedPhoto) setPhotoMarked(selectedPhoto.id, true);
        if (key === "s" && selectedPhoto) setPhotoMarked(selectedPhoto.id, false);
        return;
      }
      if (isArrowNavigation) {
        event.preventDefault();
        const now = performance.now();
        if (event.repeat && now - lastArrowNavigationAtRef.current < arrowRepeatInterval) return;
        lastArrowNavigationAtRef.current = now;
        selectGroup(
          event.key === "ArrowRight"
            ? Math.min(selectedGroupIndex + 1, visibleGroups.length - 1)
            : Math.max(selectedGroupIndex - 1, 0),
        );
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function pickFolder() {
    setIsPickingFolder(true);
    setError(null);
    try {
      const picked = await api<{ path: string | null }>("/api/folders/pick", { method: "POST" });
      if (picked.path) {
        setFolder(picked.path);
        localStorage.setItem("photo-sorter-folder", picked.path);
        setResult(null);
        setSession(null);
        setCleanupOutcome(null);
        setStorageOutcome(null);
      }
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : "폴더를 선택하지 못했습니다.");
    } finally {
      setIsPickingFolder(false);
    }
  }

  async function pickDestination() {
    setIsPickingDestination(true);
    setError(null);
    try {
      const picked = await api<{ path: string | null }>("/api/folders/pick?purpose=destination", { method: "POST" });
      if (picked.path) {
        setDestination(picked.path);
        localStorage.setItem("photo-sorter-destination", picked.path);
      }
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : "저장 디렉터리를 선택하지 못했습니다.");
    } finally {
      setIsPickingDestination(false);
    }
  }

  async function openCacheDialog() {
    setIsCacheDialogOpen(true);
    setIsCacheLoading(true);
    setError(null);
    try {
      setCalculationCache(await api<CalculationCache>("/api/calculations/cache"));
    } catch (cacheError) {
      setIsCacheDialogOpen(false);
      setError(cacheError instanceof Error ? cacheError.message : "캐시 목록을 불러오지 못했습니다.");
    } finally {
      setIsCacheLoading(false);
    }
  }

  async function resetCalculations(): Promise<boolean> {
    const confirmed = window.confirm(
      "현재 분석 결과와 검토 상태를 지우고 메모리를 정리합니다. 원본 사진은 삭제되지 않습니다. 계속할까요?",
    );
    if (!confirmed) return false;

    setIsResetting(true);
    setError(null);
    setResetNotice(null);
    try {
      await api("/api/calculations/reset", { method: "POST" });
      setSession(null);
      setResult(null);
      setSelectedGroupIndex(0);
      setSelectedPhotoId(null);
      setIsTrashDialogOpen(false);
      setTrashThroughGroupIndex(null);
      setCleanupOutcome(null);
      setIsStorageDialogOpen(false);
      setStorageOutcome(null);
      setGuide(null);
      setResetNotice("계산값과 현재 분석 결과를 초기화했습니다.");
      return true;
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "계산값을 초기화하지 못했습니다.");
      return false;
    } finally {
      setIsResetting(false);
    }
  }

  async function startScan() {
    setError(null);
    setResetNotice(null);
    setCleanupOutcome(null);
    setStorageOutcome(null);
    setResult(null);
    if (!isDayLimitValid) {
      setError("분석 날짜 수는 1일 이상의 숫자로 입력해 주세요.");
      return;
    }
    try {
      localStorage.setItem("photo-sorter-folder", folder);
      const next = await api<Session>("/api/scans", {
        method: "POST",
        body: JSON.stringify({
          folder,
          threshold: activeThreshold,
          time_window_seconds: 60,
          mode: analysisMode,
          include_subfolders: includeSubfolders,
          cleanup_json_files: cleanupJsonFiles,
          day_limit: dayLimit === "" ? null : Number(dayLimit),
          date_order: dateOrder,
        }),
      });
      setSession(next);
      if (next.status === "complete" && next.result) {
        const initialResult = next.mode === "quick" ? next.result : clearCandidateMarks(next.result);
        const initialGroups = filterReviewGroups(initialResult.groups, showSingletons);
        setResult(initialResult);
        setSelectedGroupIndex(0);
        setSelectedPhotoId(firstReviewPhoto(initialGroups[0])?.id ?? null);
        if (next.reused) setResetNotice("파일과 설정이 같아 이전 계산 결과를 불러왔습니다.");
      }
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "사진 분석을 시작하지 못했습니다.");
    }
  }

  async function stopActiveOperation() {
    if (!session || (!isScanning && !isMoving) || isCancelling) return;
    setIsCancelling(true);
    setError(null);
    try {
      await api(`/api/scans/${session.id}/cancel`, { method: "POST" });
    } catch (cancelError) {
      setIsCancelling(false);
      setError(cancelError instanceof Error ? cancelError.message : "작업을 중단하지 못했습니다.");
    }
  }

  function selectGroup(index: number) {
    if (!visibleGroups[index]) return;
    setSelectedGroupIndex(index);
    setSelectedPhotoId(firstReviewPhoto(visibleGroups[index])?.id ?? null);
  }

  function updateCurrentGroup(update: (group: PhotoGroup) => PhotoGroup) {
    const currentGroupId = currentGroup?.id;
    if (!currentGroupId) return;
    setResult((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        groups: previous.groups.map((group) => (group.id === currentGroupId ? update(group) : group)),
      };
    });
  }

  function setPhotoMarked(imageId: string, marked: boolean): boolean {
    const image = currentGroup?.images.find((item) => item.id === imageId);
    if (!image) return false;
    updateCurrentGroup((group) => {
      return {
        ...group,
        images: group.images.map((image) =>
          image.id === imageId ? { ...image, marked } : image,
        ),
      };
    });
    return true;
  }

  function toggleMarked(imageId: string) {
    const image = currentGroup?.images.find((item) => item.id === imageId);
    if (image) setPhotoMarked(imageId, !image.marked);
  }

  function applySwipeDecision(imageId: string, marked: boolean) {
    setSelectedPhotoId(imageId);
    setPhotoMarked(imageId, marked);
  }

  function markCurrentGroup(marked: boolean) {
    updateCurrentGroup((group) => ({
      ...group,
      images: group.images.map((image) => ({ ...image, marked })),
    }));
  }

  function updateSingletonVisibility(show: boolean) {
    setShowSingletons(show);
    localStorage.setItem(SHOW_SINGLETONS_KEY, String(show));
    if (!result) return;

    const nextVisibleGroups = filterReviewGroups(result.groups, show);
    if (nextVisibleGroups.length === 0) {
      setSelectedGroupIndex(0);
      setSelectedPhotoId(null);
      return;
    }

    const currentGroupId = currentGroup?.id;
    const preservedGroupIndex = currentGroupId
      ? nextVisibleGroups.findIndex((group) => group.id === currentGroupId)
      : -1;
    const nextGroupIndex = preservedGroupIndex >= 0
      ? preservedGroupIndex
      : Math.min(selectedGroupIndex, nextVisibleGroups.length - 1);
    const nextGroup = nextVisibleGroups[nextGroupIndex];
    const preservedPhoto = nextGroup.images.find((image) => image.id === selectedPhotoId);
    setSelectedGroupIndex(nextGroupIndex);
    setSelectedPhotoId(preservedPhoto?.id ?? firstReviewPhoto(nextGroup)?.id ?? null);
  }

  function openTrashDialog(throughGroupIndex: number | null) {
    setTrashThroughGroupIndex(throughGroupIndex);
    setIsTrashDialogOpen(true);
  }

  function openStorageDialog() {
    if (!destination.trim()) {
      setError("보관 사진을 옮길 저장 디렉터리를 선택해 주세요.");
      return;
    }
    setIsStorageDialogOpen(true);
  }

  function closeGuide() {
    if (guide?.kind === "setup") localStorage.setItem(SETUP_GUIDE_KEY, "complete");
    if (guide?.kind === "review") localStorage.setItem(REVIEW_GUIDE_KEY, "complete");
    setGuide(null);
    window.setTimeout(() => helpButtonRef.current?.focus(), 0);
  }

  function changeGuide(nextGuide: GuideState) {
    if (guide?.kind === "review" && nextGuide.kind === "shortcuts") {
      localStorage.setItem(REVIEW_GUIDE_KEY, "complete");
    }
    setGuide(nextGuide);
  }

  function showRemainingPhotos(
    nextResult: ScanResult,
    preferredPhotoId: string | null,
    preferredGroupIndex?: number,
  ) {
    setResult(nextResult);
    const nextVisibleGroups = filterReviewGroups(nextResult.groups, showSingletons);
    if (nextVisibleGroups.length === 0) {
      setSelectedGroupIndex(0);
      setSelectedPhotoId(null);
      return;
    }

    const nextGroupIndex = preferredGroupIndex ?? Math.min(selectedGroupIndex, nextVisibleGroups.length - 1);
    const nextGroup = nextVisibleGroups[nextGroupIndex];
    const preservedSelection = nextGroup.images.find((image) => image.id === preferredPhotoId);
    setSelectedGroupIndex(nextGroupIndex);
    setSelectedPhotoId(preservedSelection?.id ?? firstReviewPhoto(nextGroup)?.id ?? null);
  }

  async function storeKeptPhotos() {
    if (!session || !result || keptPhotos.length === 0 || !destination.trim()) return;
    const resultBeforeMove = result;
    const selectedPhotoIdBeforeMove = selectedPhotoId;
    const keptPaths = keptPhotos.map((image) => image.path);

    setIsStoring(true);
    setIsStorageDialogOpen(false);
    setError(null);
    setCleanupOutcome(null);
    showRemainingPhotos(removeMovedPhotos(resultBeforeMove, keptPaths), selectedPhotoIdBeforeMove);
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const outcome = await api<StorageOutcome>(`/api/scans/${session.id}/store`, {
        method: "POST",
        body: JSON.stringify({
          image_ids: keptPhotos.map((image) => image.id),
          destination,
        }),
      });
      setStorageOutcome(outcome);
      showRemainingPhotos(
        removeMovedPhotos(resultBeforeMove, outcome.moved.map((item) => item.source)),
        selectedPhotoIdBeforeMove,
      );
      if (outcome.cancelled) {
        setResetNotice(`이동을 중단했습니다. 이미 옮긴 사진 ${outcome.moved.length.toLocaleString()}장은 이동된 위치에 남아 있습니다.`);
      }
    } catch (storageError) {
      showRemainingPhotos(resultBeforeMove, selectedPhotoIdBeforeMove);
      setError(storageError instanceof Error ? storageError.message : "보관 사진을 저장 위치로 옮기지 못했습니다.");
    } finally {
      setIsStoring(false);
      setIsCancelling(false);
    }
  }

  async function trashMarked() {
    if (!session || !result || pendingTrashPhotos.length === 0) return;
    const resultBeforeTrash = result;
    const selectedPhotoIdBeforeTrash = selectedPhotoId;
    const candidatePaths = pendingTrashPhotos.map((image) => image.path);
    setIsTrashing(true);
    setIsTrashDialogOpen(false);
    setError(null);
    setStorageOutcome(null);
    // Remove pending cards before the files move so lazy image requests cannot
    // race the trash operation and request a path that has just disappeared.
    showRemainingPhotos(removeMovedPhotos(resultBeforeTrash, candidatePaths), selectedPhotoIdBeforeTrash);
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const outcome = await api<CleanupOutcome>(`/api/scans/${session.id}/trash`, {
        method: "POST",
        body: JSON.stringify({
          image_ids: pendingTrashPhotos.map((image) => image.id),
          allow_delete_all: fullyMarkedGroupCount > 0,
        }),
      });
      setCleanupOutcome(outcome);
      const nextResult = removeMovedPhotos(resultBeforeTrash, outcome.moved);
      const nextCandidateGroupIndex = filterReviewGroups(nextResult.groups, showSingletons).findIndex(
        (group) => group.images.some((image) => image.marked),
      );
      showRemainingPhotos(
        nextResult,
        nextCandidateGroupIndex >= 0 ? null : selectedPhotoIdBeforeTrash,
        nextCandidateGroupIndex >= 0 ? nextCandidateGroupIndex : undefined,
      );
      if (outcome.cancelled) {
        setResetNotice(`휴지통 이동을 중단했습니다. 이미 옮긴 사진 ${outcome.moved.length.toLocaleString()}장은 휴지통에서 복원할 수 있습니다.`);
      }
    } catch (trashError) {
      showRemainingPhotos(resultBeforeTrash, selectedPhotoIdBeforeTrash);
      setError(trashError instanceof Error ? trashError.message : "휴지통으로 이동하지 못했습니다.");
    } finally {
      setIsTrashing(false);
      setIsCancelling(false);
      setTrashThroughGroupIndex(null);
    }
  }

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="app-identity">
          <span className="app-mark"><ImageSquare size={19} weight="fill" /></span>
          <span className="app-name">사진 정리</span>
        </div>
        <div className="titlebar-actions">
          {(isScanning || isMoving) && (
            <button className="button button-danger-soft compact" onClick={stopActiveOperation} disabled={isCancelling}>
              <Stop size={16} weight="fill" />
              {isCancelling ? "중단 중" : isScanning ? "분석 중단" : "이동 중단"}
            </button>
          )}
          <button ref={helpButtonRef} className="button button-secondary compact" onClick={() => setGuide({ kind: "menu", step: 0 })}>
            <Question size={16} weight="bold" />사용법
          </button>
          <button className="button button-secondary compact" onClick={openCacheDialog}>
            <Database size={16} />캐시 목록
          </button>
          <button className="button button-secondary compact" onClick={resetCalculations} disabled={isScanning || isMoving || isResetting}>
            <ArrowCounterClockwise size={16} />
            {isResetting ? "초기화 중" : "계산값 초기화"}
          </button>
          <button className="button button-secondary compact" onClick={pickFolder} disabled={isPickingFolder || isScanning || isMoving}>
            <FolderOpen size={16} />
            {isPickingFolder ? "선택 중" : "폴더 선택"}
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <WarningCircle size={18} weight="fill" />
          <span>{error}</span>
          <button aria-label="오류 닫기" onClick={() => setError(null)}><X size={16} /></button>
        </div>
      )}

      {resetNotice && (
        <div className="cleanup-banner" role="status">
          <CheckCircle size={18} weight="fill" />
          <span>{resetNotice}</span>
          <button aria-label="알림 닫기" onClick={() => setResetNotice(null)}><X size={16} /></button>
        </div>
      )}

      {storageOutcome && result && result.groups.length > 0 && (
        <div className={`cleanup-banner ${storageOutcome.failures.length ? "has-failures" : ""}`} role="status">
          {storageOutcome.failures.length ? <WarningCircle size={18} weight="fill" /> : <CheckCircle size={18} weight="fill" />}
          <div className="banner-copy">
            <span>
              보관 사진 {storageOutcome.moved.length.toLocaleString()}장을 촬영일 폴더로 옮겼습니다.
              {storageOutcome.failures.length ? ` ${storageOutcome.failures.length.toLocaleString()}장은 옮기지 못했습니다.` : ""}
              {` 남은 ${result.groups.length.toLocaleString()}개 그룹을 계속 검토할 수 있습니다.`}
            </span>
            {storageOutcome.failures[0] && (
              <small title={`${storageOutcome.failures[0].path}${storageOutcome.failures[0].destination ? ` → ${storageOutcome.failures[0].destination}` : ""}`}>
                첫 오류: {shortPath(storageOutcome.failures[0].path)}
                {storageOutcome.failures[0].destination ? ` → ${shortPath(storageOutcome.failures[0].destination)}` : ""}
                {` · ${storageOutcome.failures[0].reason || "알 수 없는 오류"}`}
              </small>
            )}
          </div>
          <button aria-label="알림 닫기" onClick={() => setStorageOutcome(null)}><X size={16} /></button>
        </div>
      )}

      {cleanupOutcome && result && result.groups.length > 0 && (
        <div className={`cleanup-banner ${cleanupOutcome.failures.length ? "has-failures" : ""}`} role="status">
          {cleanupOutcome.failures.length ? <WarningCircle size={18} weight="fill" /> : <CheckCircle size={18} weight="fill" />}
          <span>
            {cleanupOutcome.moved.length.toLocaleString()}장을 휴지통으로 옮겼습니다.
            {cleanupOutcome.failures.length ? ` ${cleanupOutcome.failures.length.toLocaleString()}장은 옮기지 못했습니다.` : ""}
            {markedPhotos.length > 0
              ? ` 남은 ${result.groups.length.toLocaleString()}개 그룹을 계속 검토할 수 있습니다.`
              : " 남겨 둔 사진을 보관 위치로 옮길 수 있습니다."}
          </span>
          <button aria-label="알림 닫기" onClick={() => setCleanupOutcome(null)}><X size={16} /></button>
        </div>
      )}

      <div className="workspace">
        <aside className="sidebar">
          <section className="settings-panel">
            <div className="panel-heading">
              <div>
                <h2>분석 설정</h2>
                <p>폴더와 방식을 정한 뒤 분석을 시작하세요.</p>
              </div>
            </div>

            <label className="field-label" htmlFor="folder-path">사진 폴더</label>
            <div className="path-input-row" data-guide="folder">
              <input
                id="folder-path"
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
                spellCheck={false}
                disabled={isScanning}
              />
              <button className="icon-button" aria-label="폴더 선택" onClick={pickFolder} disabled={isScanning}>
                <FolderOpen size={18} />
              </button>
            </div>

            <label className="field-label destination-label" htmlFor="destination-path">보관 저장 위치</label>
            <div className="path-input-row">
              <input
                id="destination-path"
                value={destination}
                onChange={(event) => {
                  const value = event.target.value;
                  setDestination(value);
                  if (value) localStorage.setItem("photo-sorter-destination", value);
                  else localStorage.removeItem("photo-sorter-destination");
                }}
                placeholder="저장 루트 폴더"
                spellCheck={false}
                disabled={isScanning || isStoring}
              />
              <button
                className="icon-button"
                aria-label="보관 저장 위치 선택"
                onClick={pickDestination}
                disabled={isScanning || isStoring || isPickingDestination}
              >
                <FolderOpen size={18} />
              </button>
            </div>
            <p className="destination-help">선택 위치 아래 Photos/YYYYMMDD로 이동합니다.</p>

            <span className="field-label mode-label" id="analysis-mode-label">분석 방식</span>
            <div className="mode-selector" role="radiogroup" aria-labelledby="analysis-mode-label" data-guide="mode">
              <button
                className={analysisMode === "standard" ? "selected" : ""}
                role="radio"
                aria-checked={analysisMode === "standard"}
                onClick={() => setAnalysisMode("standard")}
                disabled={isScanning}
              >
                <MagnifyingGlass size={15} />일반 분석
              </button>
              <button
                className={analysisMode === "quick" ? "selected" : ""}
                role="radio"
                aria-checked={analysisMode === "quick"}
                onClick={() => setAnalysisMode("quick")}
                disabled={isScanning}
              >
                <Lightning size={15} weight="fill" />빠른 분석
              </button>
            </div>
            <p className="mode-help">
              {analysisMode === "quick" ? "보관 사진을 추천하고 후보를 미리 표시합니다." : "보관할 사진을 직접 선택합니다."}
            </p>

            <div className={`advanced-settings ${isAdvancedOpen ? "open" : ""} ${!isDayLimitValid ? "has-error" : ""}`}>
              <button
                className="advanced-settings-toggle"
                type="button"
                aria-expanded={isAdvancedOpen}
                aria-controls="advanced-settings-content"
                onClick={() => setIsAdvancedOpen((open) => !open)}
                data-guide="advanced"
              >
                <span>
                  <strong>세부 설정</strong>
                  <small>{advancedSummary}</small>
                </span>
                <CaretDown size={16} weight="bold" aria-hidden="true" />
              </button>

              <div className="advanced-settings-content" id="advanced-settings-content" hidden={!isAdvancedOpen}>
                <div className="binary-setting">
                  <div>
                    <strong id="subfolder-label">하위 폴더 탐색</strong>
                    <span>{includeSubfolders ? "중첩된 모든 폴더의 사진 포함" : "선택한 폴더의 사진만 포함"}</span>
                  </div>
                  <div className="binary-selector" role="radiogroup" aria-labelledby="subfolder-label">
                    <button
                      className={includeSubfolders ? "selected" : ""}
                      role="radio"
                      aria-checked={includeSubfolders}
                      aria-label="하위 폴더 탐색 O"
                      onClick={() => {
                        setIncludeSubfolders(true);
                        localStorage.setItem("photo-sorter-include-subfolders", "true");
                      }}
                      disabled={isScanning}
                    >
                      O
                    </button>
                    <button
                      className={!includeSubfolders ? "selected" : ""}
                      role="radio"
                      aria-checked={!includeSubfolders}
                      aria-label="하위 폴더 탐색 X"
                      onClick={() => {
                        setIncludeSubfolders(false);
                        localStorage.setItem("photo-sorter-include-subfolders", "false");
                      }}
                      disabled={isScanning}
                    >
                      X
                    </button>
                  </div>
                </div>

                <div className="binary-setting">
                  <div>
                    <strong id="json-cleanup-label">JSON 파일 청소</strong>
                    <span>{cleanupJsonFiles ? "분석 시작 시 검사 경로의 JSON 파일 삭제" : "JSON 파일을 그대로 유지"}</span>
                  </div>
                  <div className="binary-selector" role="radiogroup" aria-labelledby="json-cleanup-label">
                    <button
                      className={cleanupJsonFiles ? "selected" : ""}
                      role="radio"
                      aria-checked={cleanupJsonFiles}
                      aria-label="JSON 파일 청소 O"
                      onClick={() => {
                        setCleanupJsonFiles(true);
                        localStorage.setItem(CLEANUP_JSON_KEY, "true");
                      }}
                      disabled={isScanning}
                    >
                      O
                    </button>
                    <button
                      className={!cleanupJsonFiles ? "selected" : ""}
                      role="radio"
                      aria-checked={!cleanupJsonFiles}
                      aria-label="JSON 파일 청소 X"
                      onClick={() => {
                        setCleanupJsonFiles(false);
                        localStorage.setItem(CLEANUP_JSON_KEY, "false");
                      }}
                      disabled={isScanning}
                    >
                      X
                    </button>
                  </div>
                </div>

                <div className="binary-setting">
                  <div>
                    <strong id="singleton-visibility-label">단독 사진 표시</strong>
                    <span>{showSingletons ? "1장짜리 그룹을 함께 표시" : "유사 사진 그룹만 표시"}</span>
                  </div>
                  <div className="binary-selector" role="radiogroup" aria-labelledby="singleton-visibility-label">
                    <button
                      className={showSingletons ? "selected" : ""}
                      role="radio"
                      aria-checked={showSingletons}
                      aria-label="단독 사진 표시 O"
                      onClick={() => updateSingletonVisibility(true)}
                    >
                      O
                    </button>
                    <button
                      className={!showSingletons ? "selected" : ""}
                      role="radio"
                      aria-checked={!showSingletons}
                      aria-label="단독 사진 표시 X"
                      onClick={() => updateSingletonVisibility(false)}
                    >
                      X
                    </button>
                  </div>
                </div>

                <div className="setting-block date-limit-setting">
                  <div className="setting-row">
                    <label htmlFor="day-limit">분석 날짜 수</label>
                    <div className="day-limit-input">
                      <input
                        id="day-limit"
                        type="number"
                        min="1"
                        inputMode="numeric"
                        placeholder="전체"
                        value={dayLimit}
                        onChange={(event) => {
                          const value = event.target.value;
                          setDayLimit(value);
                          if (value) localStorage.setItem("photo-sorter-day-limit", value);
                          else localStorage.removeItem("photo-sorter-day-limit");
                        }}
                        disabled={isScanning}
                        aria-invalid={!isDayLimitValid}
                      />
                      <span>일</span>
                    </div>
                  </div>
                  <p className="setting-help">EXIF 촬영일을 우선해 서로 다른 날짜를 선택합니다.</p>
                  <div className="date-order-selector" role="radiogroup" aria-label="날짜 정렬 방향">
                    <button
                      className={dateOrder === "oldest" ? "selected" : ""}
                      role="radio"
                      aria-checked={dateOrder === "oldest"}
                      onClick={() => {
                        setDateOrder("oldest");
                        localStorage.setItem("photo-sorter-date-order", "oldest");
                      }}
                      disabled={isScanning}
                    >
                      <ArrowUp size={14} />오래된 날부터
                    </button>
                    <button
                      className={dateOrder === "newest" ? "selected" : ""}
                      role="radio"
                      aria-checked={dateOrder === "newest"}
                      onClick={() => {
                        setDateOrder("newest");
                        localStorage.setItem("photo-sorter-date-order", "newest");
                      }}
                      disabled={isScanning}
                    >
                      <ArrowDown size={14} />최신 날부터
                    </button>
                  </div>
                  {!isDayLimitValid && <p className="field-error">1 이상의 숫자를 입력해 주세요.</p>}
                </div>

                <div className="setting-block">
                  <div className="setting-row">
                    <label htmlFor="arrow-repeat-interval">방향키 연속 이동 속도</label>
                    <output htmlFor="arrow-repeat-interval">{arrowRepeatInterval}ms/그룹</output>
                  </div>
                  <input
                    id="arrow-repeat-interval"
                    className="range"
                    type="range"
                    min="100"
                    max="1000"
                    step="50"
                    value={arrowRepeatInterval}
                    onChange={(event) => {
                      const interval = Number(event.target.value);
                      setArrowRepeatInterval(interval);
                      localStorage.setItem(ARROW_REPEAT_INTERVAL_KEY, String(interval));
                    }}
                  />
                  <div className="range-labels"><span>빠르게</span><span>천천히</span></div>
                </div>

                <div className="setting-block">
                  <div className="setting-row">
                    <label htmlFor="similarity">유사도 기준</label>
                    <output htmlFor="similarity">{activeThreshold}% 이상</output>
                  </div>
                  <input
                    id="similarity"
                    className="range"
                    type="range"
                    min="70"
                    max="99"
                    value={activeThreshold}
                    onChange={(event) => {
                      const nextThreshold = Number(event.target.value);
                      if (analysisMode === "quick") setQuickThreshold(nextThreshold);
                      else setThreshold(nextThreshold);
                    }}
                    disabled={isScanning}
                  />
                  <div className="range-labels"><span>넓게 찾기</span><span>거의 동일</span></div>
                </div>
              </div>
            </div>

            {result && (
              <div className="selected-period" role="status">
                <span>선정 기간</span>
                <strong>{formatSelectedPeriod(result.selected_date_start, result.selected_date_end)}</strong>
                <small>
                  {result.stats.selected_days.toLocaleString()}일, {result.stats.analyzed.toLocaleString()}개 파일 분석
                  {result.stats.json_files_deleted > 0 ? ` · JSON ${result.stats.json_files_deleted.toLocaleString()}개 삭제` : ""}
                </small>
              </div>
            )}

            <button className="button button-primary scan-button" onClick={startScan} disabled={isScanning || !folder.trim() || !isDayLimitValid} data-guide="scan">
              {analysisMode === "quick" ? <Lightning size={17} weight="fill" /> : <Sparkle size={17} weight="fill" />}
              {isScanning ? "분석 중" : analysisMode === "quick" ? "빠른 분석 시작" : result ? "다시 분석" : "사진 분석"}
            </button>
          </section>

          {visibleGroups.length > 0 && session && (
            <section className="group-list-section" aria-label="분석 사진 그룹" data-guide="groups">
              <div className="group-list-heading">
                <h2>{session.mode === "quick" ? "검토할 사진" : "분석 사진"}</h2>
                <span>{visibleGroups.length}</span>
              </div>
              <div className="group-list">
                {visibleGroups.map((group, index) => (
                  <button
                    key={group.id}
                    className={`group-row ${index === selectedGroupIndex ? "selected" : ""}`}
                    onClick={() => selectGroup(index)}
                  >
                    <span className="group-thumbnails">
                      {group.images.slice(0, 2).map((image) => (
                        <img key={image.id} src={imageUrl(session.id, image.id, "thumb")} alt="" loading="lazy" />
                      ))}
                    </span>
                    <span className="group-copy">
                      <strong>{group.member_count === 1 ? `단독 사진 ${index + 1}` : `그룹 ${index + 1}`}</strong>
                      <small>
                        {group.member_count === 1
                          ? "1장, 보관 또는 삭제 가능"
                          : `${group.member_count}장, ${group.folder_count}개 폴더, 최대 ${group.max_similarity}%`}
                      </small>
                    </span>
                    <span className={`group-count ${group.images.some((image) => image.marked) ? "" : "empty"}`}>
                      {group.images.filter((image) => image.marked).length}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </aside>

        <main className="main-content">
          {storageOutcome && (!result || result.groups.length === 0) ? (
            <StorageCompletionView
              outcome={storageOutcome}
              destination={destination}
              onStartOver={() => {
                setStorageOutcome(null);
                setResult(null);
                setSession(null);
              }}
            />
          ) : cleanupOutcome && (!result || result.groups.length === 0) ? (
            <CompletionView outcome={cleanupOutcome} onStartOver={() => { setCleanupOutcome(null); setResult(null); setSession(null); }} />
          ) : isScanning && session ? (
            <ScanningView session={session} />
          ) : result && result.groups.length === 0 ? (
            <EmptyResults result={result} onRescan={startScan} />
          ) : result && visibleGroups.length === 0 && hiddenVideos.length > 0 ? (
            <HiddenVideosView
              count={hiddenVideos.length}
              hiddenSingletonPhotoCount={showSingletons ? 0 : hiddenSingletonPhotoCount}
              keptCount={keptPhotos.length}
              keptBytes={keptBytes}
              canStore={Boolean(destination.trim()) && !isStoring}
              onStore={openStorageDialog}
              onShowSingletons={() => updateSingletonVisibility(true)}
            />
          ) : result && visibleGroups.length === 0 ? (
            <HiddenSingletonsView
              count={hiddenSingletonPhotoCount}
              keptCount={keptPhotos.length}
              keptBytes={keptBytes}
              canStore={Boolean(destination.trim()) && !isStoring}
              onStore={openStorageDialog}
              onShow={() => updateSingletonVisibility(true)}
            />
          ) : result && currentGroup && selectedPhoto && session ? (
            <ReviewWorkspace
              scanId={session.id}
              groupCount={visibleGroups.length}
              group={currentGroup}
              groupIndex={selectedGroupIndex}
              selectedPhoto={selectedPhoto}
              keptCount={keptPhotos.length}
              keptBytes={keptBytes}
              markedCount={markedPhotos.length}
              markedBytes={markedBytes}
              throughCurrentMarkedCount={throughCurrentMarkedPhotos.length}
              throughCurrentMarkedBytes={throughCurrentMarkedBytes}
              mode={session.mode}
              onPrevious={() => selectGroup(Math.max(0, selectedGroupIndex - 1))}
              onNext={() => selectGroup(Math.min(visibleGroups.length - 1, selectedGroupIndex + 1))}
              onSelectPhoto={setSelectedPhotoId}
              onToggleMarked={() => toggleMarked(selectedPhoto.id)}
              onMarkAll={() => markCurrentGroup(true)}
              onKeepAll={() => markCurrentGroup(false)}
              onSwipeDecision={applySwipeDecision}
              onStore={openStorageDialog}
              canStore={Boolean(destination.trim()) && !isStoring}
              onTrash={() => openTrashDialog(null)}
              onTrashThrough={() => openTrashDialog(selectedGroupIndex)}
            />
          ) : (
            <WelcomeView
              onChoose={pickFolder}
              onScan={startScan}
              folder={folder}
              mode={analysisMode}
              threshold={activeThreshold}
              includeSubfolders={includeSubfolders}
            />
          )}
        </main>
      </div>

      {isTrashDialogOpen && (
        <TrashDialog
          count={pendingTrashPhotos.length}
          bytes={pendingTrashBytes}
          partial={trashThroughGroupIndex !== null}
          fullyMarkedGroupCount={fullyMarkedGroupCount}
          loading={isTrashing}
          onCancel={() => { setIsTrashDialogOpen(false); setTrashThroughGroupIndex(null); }}
          onConfirm={trashMarked}
        />
      )}

      {isStorageDialogOpen && (
        <StorageDialog
          count={keptPhotos.length}
          bytes={keptBytes}
          destination={destination}
          loading={isStoring}
          onCancel={() => setIsStorageDialogOpen(false)}
          onConfirm={storeKeptPhotos}
        />
      )}

      {isCacheDialogOpen && (
        <CacheDialog
          cache={calculationCache}
          loading={isCacheLoading}
          resetting={isResetting}
          canReset={!isScanning && !isMoving}
          onCancel={() => setIsCacheDialogOpen(false)}
          onReset={async () => {
            if (await resetCalculations()) setIsCacheDialogOpen(false);
          }}
        />
      )}

      {guide && (
        <GuideOverlay
          guide={guide}
          hasReview={visibleGroups.length > 0}
          onChange={changeGuide}
          onClose={closeGuide}
        />
      )}
    </div>
  );
}

function WelcomeView({
  onChoose,
  onScan,
  folder,
  mode,
  threshold,
  includeSubfolders,
}: {
  onChoose: () => void;
  onScan: () => void;
  folder: string;
  mode: AnalysisMode;
  threshold: number;
  includeSubfolders: boolean;
}) {
  return (
    <div className="welcome-view">
      <div className="welcome-icon">{mode === "quick" ? <Lightning size={38} weight="duotone" /> : <ImageSquare size={38} weight="duotone" />}</div>
      <h1>{mode === "quick" ? "매우 비슷한 사진부터 빠르게 검토하세요" : "비슷한 사진을 안전하게 정리하세요"}</h1>
      <p>{mode === "quick" ? `${threshold}% 이상 비슷한 사진을 모아 보관할 사진을 추천하고, 나머지는 삭제 후보로 준비합니다. 휴지통으로 옮기기 전에 선택을 직접 확인할 수 있습니다.` : "선택한 폴더 안에서 비슷한 사진을 찾아 한눈에 비교할 수 있도록 모아 보여줍니다. 사진은 외부로 전송되지 않으며, 삭제 후보는 직접 선택합니다."}</p>
      <div className="welcome-actions">
        <button className="button button-secondary" onClick={onChoose}><FolderOpen size={17} />다른 폴더 선택</button>
        <button className="button button-primary" onClick={onScan} disabled={!folder}>
          {mode === "quick" ? <Lightning size={17} weight="fill" /> : <Sparkle size={17} weight="fill" />}
          {mode === "quick" ? "빠른 분석" : "분석 시작"}
        </button>
      </div>
      <div className="workflow-notes">
        <div><span>1</span><strong>사진 찾기</strong><small>{includeSubfolders ? "하위 폴더 포함" : "선택한 폴더만"}</small></div>
        <div><span>2</span><strong>유사 사진 모으기</strong><small>한눈에 비교</small></div>
        <div><span>3</span><strong>확인 후 정리</strong><small>휴지통으로 이동</small></div>
      </div>
    </div>
  );
}

function ScanningView({ session }: { session: Session }) {
  const progress = session.total ? Math.round((session.completed / session.total) * 100) : 0;
  const phaseLabel = session.phase === "cancelling"
    ? "사진 분석을 중단하는 중"
    : session.phase === "indexing"
    ? "사진 촬영일을 확인하는 중"
    : session.phase === "comparing"
      ? session.mode === "quick" ? "매우 비슷한 사진을 찾는 중" : "비슷한 사진을 찾는 중"
      : "사진을 살펴보는 중";
  return (
    <div className="scanning-view" aria-live="polite">
      <div className="scan-status-row">
        <div className="scan-icon">{session.mode === "quick" ? <Lightning size={22} weight="fill" /> : <MagnifyingGlass size={22} />}</div>
        <div><h1>{phaseLabel}</h1><p>{shortPath(session.folder)}</p></div>
        <strong>{progress}%</strong>
      </div>
      <div className="progress-track"><span style={{ transform: `scaleX(${progress / 100})` }} /></div>
      <p className="progress-detail">{session.completed.toLocaleString()} / {session.total.toLocaleString()} 처리</p>
      {session.selected_date_start && session.selected_date_end && (
        <div className="scan-period">
          <span>선정된 분석 기간</span>
          <strong>{formatSelectedPeriod(session.selected_date_start, session.selected_date_end)}</strong>
        </div>
      )}
      <div className="skeleton-comparison" aria-hidden="true">
        <div className="skeleton-card"><span /><small /></div>
        <div className="skeleton-card"><span /><small /></div>
      </div>
      <div className="local-note"><ShieldCheck size={17} />사진과 분석 결과는 외부로 전송되지 않습니다.</div>
    </div>
  );
}

function EmptyResults({ result, onRescan }: { result: ScanResult; onRescan: () => void }) {
  return (
    <div className="welcome-view">
      <div className="welcome-icon success"><CheckCircle size={40} weight="duotone" /></div>
      <h1>정리할 유사 사진이 없습니다</h1>
      <p>{result.stats.source_folders.toLocaleString()}개 폴더의 사진 {result.stats.analyzed.toLocaleString()}장을 확인했지만 현재 {result.threshold}% 기준에 맞는 유사 사진을 찾지 못했습니다.</p>
      <button className="button button-secondary" onClick={onRescan}>설정을 바꿔 다시 분석</button>
    </div>
  );
}

function HiddenVideosView({
  count,
  hiddenSingletonPhotoCount,
  keptCount,
  keptBytes,
  canStore,
  onStore,
  onShowSingletons,
}: {
  count: number;
  hiddenSingletonPhotoCount: number;
  keptCount: number;
  keptBytes: number;
  canStore: boolean;
  onStore: () => void;
  onShowSingletons: () => void;
}) {
  return (
    <div className="welcome-view">
      <div className="welcome-icon success"><CheckCircle size={40} weight="duotone" /></div>
      <h1>사진 미리보기가 모두 끝났습니다</h1>
      <p>
        영상 {count.toLocaleString()}개는 미리보기에 표시하지 않으며, 보관하면 촬영일 폴더로 함께 이동합니다.
      </p>
      <div className="welcome-actions">
        {hiddenSingletonPhotoCount > 0 && (
          <button className="button button-secondary" onClick={onShowSingletons}>
            단독 사진 {hiddenSingletonPhotoCount.toLocaleString()}장 표시
          </button>
        )}
        <button
          className="button button-primary"
          onClick={onStore}
          disabled={!canStore || keptCount === 0}
          title={canStore ? "보관 파일을 촬영일 폴더로 이동" : "보관 저장 위치를 먼저 선택해 주세요"}
        >
          <FolderOpen size={16} />보관 {keptCount.toLocaleString()}개 이동 <span>{formatBytes(keptBytes)}</span>
        </button>
      </div>
    </div>
  );
}

function HiddenSingletonsView({
  count,
  keptCount,
  keptBytes,
  canStore,
  onStore,
  onShow,
}: {
  count: number;
  keptCount: number;
  keptBytes: number;
  canStore: boolean;
  onStore: () => void;
  onShow: () => void;
}) {
  return (
    <div className="welcome-view">
      <div className="welcome-icon"><ImageSquare size={40} weight="duotone" /></div>
      <h1>단독 사진을 숨겼습니다</h1>
      <p>
        현재 표시할 유사 사진 그룹이 없습니다. 숨겨진 단독 사진 {count.toLocaleString()}장은
        보관 이동 대상에 계속 포함되며 언제든 다시 표시할 수 있습니다.
      </p>
      <div className="welcome-actions">
        <button className="button button-secondary" onClick={onShow}>단독 사진 표시</button>
        <button
          className="button button-primary"
          onClick={onStore}
          disabled={!canStore || keptCount === 0}
          title={canStore ? "보관 사진을 촬영일 폴더로 이동" : "보관 저장 위치를 먼저 선택해 주세요"}
        >
          <FolderOpen size={16} />보관 {keptCount.toLocaleString()}장 이동 <span>{formatBytes(keptBytes)}</span>
        </button>
      </div>
    </div>
  );
}

function StorageCompletionView({
  outcome,
  destination,
  onStartOver,
}: {
  outcome: StorageOutcome;
  destination: string;
  onStartOver: () => void;
}) {
  return (
    <div className="welcome-view">
      <div className={`welcome-icon ${outcome.failures.length ? "warning" : "success"}`}>
        {outcome.failures.length ? <WarningCircle size={40} weight="duotone" /> : <CheckCircle size={40} weight="duotone" />}
      </div>
      <h1>보관 사진 {outcome.moved.length.toLocaleString()}장을 옮겼습니다</h1>
      <p>
        {destination}/Photos 아래에서 촬영 날짜별 폴더로 확인할 수 있습니다.
        {outcome.failures.length ? ` ${outcome.failures.length.toLocaleString()}장은 원래 위치에 남아 있습니다.` : ""}
      </p>
      <button className="button button-primary" onClick={onStartOver}>새 폴더 정리</button>
    </div>
  );
}

function CompletionView({ outcome, onStartOver }: { outcome: CleanupOutcome; onStartOver: () => void }) {
  return (
    <div className="welcome-view">
      <div className={`welcome-icon ${outcome.failures.length ? "warning" : "success"}`}>
        {outcome.failures.length ? <WarningCircle size={40} weight="duotone" /> : <CheckCircle size={40} weight="duotone" />}
      </div>
      <h1>{outcome.moved.length.toLocaleString()}장을 휴지통으로 옮겼습니다</h1>
      <p>{outcome.failures.length ? `${outcome.failures.length}장은 옮기지 못해 원래 위치에 남아 있습니다.` : "필요하면 휴지통에서 원래 위치로 복원할 수 있습니다."}</p>
      <button className="button button-primary" onClick={onStartOver}>새 폴더 정리</button>
    </div>
  );
}

type ReviewProps = {
  scanId: string;
  groupCount: number;
  group: PhotoGroup;
  groupIndex: number;
  selectedPhoto: Photo;
  keptCount: number;
  keptBytes: number;
  markedCount: number;
  markedBytes: number;
  throughCurrentMarkedCount: number;
  throughCurrentMarkedBytes: number;
  mode: AnalysisMode;
  onPrevious: () => void;
  onNext: () => void;
  onSelectPhoto: (id: string) => void;
  onToggleMarked: () => void;
  onMarkAll: () => void;
  onKeepAll: () => void;
  onSwipeDecision: (id: string, marked: boolean) => void;
  onStore: () => void;
  canStore: boolean;
  onTrash: () => void;
  onTrashThrough: () => void;
};

function ReviewWorkspace(props: ReviewProps) {
  const { group, groupIndex, selectedPhoto } = props;
  const visibleColumns = Math.min(group.images.length, 3);
  return (
    <div className="review-workspace">
      <div className="review-toolbar" data-guide="review-toolbar">
        <div className="review-summary">
          <strong>{group.member_count === 1 ? `단독 사진 ${groupIndex + 1}` : `그룹 ${groupIndex + 1}`}</strong>
          <span>{props.groupCount}개 중</span>
          <span className="separator" />
          <span>{group.member_count}장</span>
          <span>{group.folder_count}개 폴더</span>
        </div>
        <div className="group-navigation">
          <button className="icon-button" aria-label="이전 그룹" onClick={props.onPrevious} disabled={groupIndex === 0}><ArrowLeft size={18} /></button>
          <button className="icon-button" aria-label="다음 그룹" onClick={props.onNext} disabled={groupIndex === props.groupCount - 1}><ArrowRight size={18} /></button>
        </div>
      </div>

      <div
        className="swipe-gallery"
        data-guide="swipe"
        style={{ "--gallery-columns": visibleColumns } as CSSProperties}
        aria-label={
          group.member_count === 1
            ? "단독 사진 1장"
            : `그룹 ${groupIndex + 1} 사진 ${group.images.length}장`
        }
      >
        {group.images.map((image, index) => (
          <SwipePhotoViewer
            key={image.id}
            scanId={props.scanId}
            photo={image}
            selected={image.id === selectedPhoto.id}
            shortcutNumber={index < 9 ? index + 1 : null}
            keepLabel={group.member_count === 1 ? "보관" : props.mode === "quick" ? image.id === group.keep_id ? "추천 보존" : "보존" : "보관"}
            onSelect={() => props.onSelectPhoto(image.id)}
            onSave={() => props.onSwipeDecision(image.id, false)}
            onDelete={() => props.onSwipeDecision(image.id, true)}
          />
        ))}
      </div>

      <div className="filmstrip-section" data-guide="filmstrip">
        <div className="filmstrip-heading">
          <span>{group.member_count === 1 ? "단독 사진" : "이 그룹의 사진"}</span>
          <div className="group-tools">
            <button className="keep-all" onClick={props.onKeepAll}><Check size={14} weight="bold" />전부 보관 <kbd>⇧N</kbd></button>
            <button className="mark-all" onClick={props.onMarkAll}><WarningCircle size={14} weight="fill" />전부 후보 <kbd>⇧A</kbd></button>
          </div>
        </div>
        <div className="filmstrip">
          {group.images.map((image, index) => (
            <button
              key={image.id}
              className={`filmstrip-item ${image.id === selectedPhoto.id ? "selected" : ""} ${image.marked ? "marked" : "kept"}`}
              onClick={() => props.onSelectPhoto(image.id)}
              aria-label={`${index < 9 ? `${index + 1}번, ` : ""}${image.relative_path}, ${image.marked ? "삭제 후보" : "보관"}`}
            >
              <img src={imageUrl(props.scanId, image.id, "thumb")} alt="" loading="lazy" decoding="async" />
              {index < 9 && <kbd className="filmstrip-shortcut">{index + 1}</kbd>}
              <span>{image.marked ? <WarningCircle size={12} weight="fill" /> : <Check size={12} weight="bold" />}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="actionbar" data-guide="cleanup">
        <div className="keyboard-hint">
          <Keyboard size={16} />
          {props.mode === "quick" && <span><kbd>←</kbd><kbd>→</kbd> 그룹 이동</span>}
          <span><kbd>1-9</kbd> 1장만 보관</span>
          <span><kbd>⇧S</kbd> 보관</span>
          <span><kbd>⇧D</kbd> 후보</span>
        </div>
        <div className="candidate-summary" aria-live="polite">
          <span>{props.mode === "quick" ? "여기까지 후보" : "삭제 후보"}</span>
          <strong>{(props.mode === "quick" ? props.throughCurrentMarkedCount : props.markedCount).toLocaleString()}건</strong>
          <small>{formatBytes(props.mode === "quick" ? props.throughCurrentMarkedBytes : props.markedBytes)}</small>
        </div>
        <div className="review-actions">
          <button
            className="button button-secondary"
            onClick={props.onStore}
            disabled={!props.canStore || props.keptCount === 0}
            title={props.canStore ? "보관 사진을 촬영일 폴더로 이동" : "보관 저장 위치를 먼저 선택해 주세요"}
          >
            <FolderOpen size={16} />
            보관 {props.keptCount.toLocaleString()}장 이동
            <span>{formatBytes(props.keptBytes)}</span>
          </button>
          <button className={`button ${selectedPhoto.marked ? "button-secondary" : "button-danger-soft"}`} onClick={props.onToggleMarked}>
            {selectedPhoto.marked ? <Check size={16} weight="bold" /> : <WarningCircle size={16} weight="fill" />}
            {selectedPhoto.marked ? "후보 해제" : "후보 추가"}
          </button>
          <button
            className="button button-danger"
            onClick={props.mode === "quick" ? props.onTrashThrough : props.onTrash}
            disabled={(props.mode === "quick" ? props.throughCurrentMarkedCount : props.markedCount) === 0}
          >
            <Trash size={16} weight="fill" />
            {props.mode === "quick" ? "여기까지 정리하기" : `후보 ${props.markedCount.toLocaleString()}건 이동`}
            <span>{formatBytes(props.mode === "quick" ? props.throughCurrentMarkedBytes : props.markedBytes)}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function SwipePhotoViewer({
  scanId,
  photo,
  selected,
  shortcutNumber,
  keepLabel,
  onSelect,
  onSave,
  onDelete,
}: {
  scanId: string;
  photo: Photo;
  selected: boolean;
  shortcutNumber: number | null;
  keepLabel: string;
  onSelect: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const dragYRef = useRef(0);
  const pointerIdRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const completingRef = useRef(false);

  function resetCard() {
    const slot = slotRef.current;
    const card = cardRef.current;
    if (slot) {
      slot.dataset.swipe = "idle";
      slot.style.setProperty("--swipe-progress", "0");
    }
    if (card) {
      card.classList.remove("dragging", "completing");
      card.style.transform = "";
      card.style.opacity = "";
    }
    pointerIdRef.current = null;
    dragYRef.current = 0;
    completingRef.current = false;
  }

  useEffect(() => {
    resetCard();
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [photo.id]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (completingRef.current) return;
    event.preventDefault();
    onSelect();
    pointerIdRef.current = event.pointerId;
    startYRef.current = event.clientY;
    dragYRef.current = 0;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("dragging");
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== event.pointerId || completingRef.current) return;
    event.preventDefault();
    const dragY = Math.max(-240, Math.min(240, event.clientY - startYRef.current));
    dragYRef.current = dragY;
    const progress = Math.min(Math.abs(dragY) / 72, 1);
    const slot = slotRef.current;
    const card = cardRef.current;
    if (slot) {
      slot.dataset.swipe = dragY < -12 ? "save" : dragY > 12 ? "delete" : "idle";
      slot.style.setProperty("--swipe-progress", String(progress));
    }
    if (card) {
      card.style.transform = `translateY(${dragY}px) rotate(${dragY * 0.015}deg)`;
      card.style.opacity = String(1 - progress * 0.16);
    }
  }

  function finishSwipe(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    if (pointerIdRef.current !== event.pointerId || completingRef.current) return;
    const card = cardRef.current;
    card?.classList.remove("dragging");
    if (cancelled || Math.abs(dragYRef.current) < 72) {
      resetCard();
      return;
    }

    completingRef.current = true;
    const save = dragYRef.current < 0;
    if (card) {
      card.classList.add("completing");
      card.style.transform = `translateY(${save ? -520 : 520}px) rotate(${save ? -5 : 5}deg)`;
      card.style.opacity = "0";
    }
    const completionDelay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
    timerRef.current = window.setTimeout(() => {
      resetCard();
      if (save) onSave();
      else onDelete();
    }, completionDelay);
  }

  return (
    <div ref={slotRef} className={`swipe-slot ${selected ? "selected" : ""}`} data-swipe="idle" style={{ "--swipe-progress": 0 } as CSSProperties}>
      <div className="swipe-decision-layer" aria-hidden="true">
        <div className="swipe-decision save">
          <ArrowUp size={32} weight="bold" />
          <strong>SAVE</strong>
          <span>보관, 후보에서 제외</span>
        </div>
        <div className="swipe-decision delete">
          <ArrowDown size={32} weight="bold" />
          <strong>DELETE</strong>
          <span>삭제 후보로 추가</span>
        </div>
      </div>
      <div
        ref={cardRef}
        className="swipe-card"
        tabIndex={0}
        onFocus={onSelect}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishSwipe}
        onPointerCancel={(event) => finishSwipe(event, true)}
        onDragStart={(event) => event.preventDefault()}
        aria-label={`${shortcutNumber ? `${shortcutNumber}번. ` : ""}${photo.relative_path}. 위로 밀면 보관, 아래로 밀면 삭제 후보${shortcutNumber ? `. 숫자키 ${shortcutNumber}로 이 사진만 보관` : ""}`}
      >
        <PhotoViewer scanId={scanId} photo={photo} shortcutNumber={shortcutNumber} label={photo.marked ? "삭제 후보" : keepLabel} tone={photo.marked ? "delete" : "keep"} />
        <div className="swipe-guide" aria-hidden="true">
          <span className="save"><ArrowUp size={13} weight="bold" />보관</span>
          <span>세로로 밀기</span>
          <span className="delete"><ArrowDown size={13} weight="bold" />후보</span>
        </div>
      </div>
    </div>
  );
}

function PhotoViewer({
  scanId,
  photo,
  shortcutNumber,
  label,
  tone,
}: {
  scanId: string;
  photo: Photo;
  shortcutNumber: number | null;
  label: string;
  tone: "keep" | "delete";
}) {
  return (
    <article className={`photo-viewer ${tone}`}>
      <div className="photo-viewer-header">
        {shortcutNumber && <kbd className="photo-shortcut" aria-label={`숫자키 ${shortcutNumber}`}>{shortcutNumber}</kbd>}
        <span className="status-label">{tone === "keep" ? <Check size={13} weight="bold" /> : <Trash size={13} weight="fill" />}{label}</span>
        <strong title={photo.relative_path}>{photo.name}</strong>
      </div>
      <div className="photo-stage"><img src={imageUrl(scanId, photo.id)} alt={photo.name} draggable={false} loading="lazy" decoding="async" /></div>
      <dl className="photo-meta">
        <div><dt>촬영 시간</dt><dd>{formatDate(photo.captured_at)}</dd></div>
        <div><dt>크기</dt><dd>{photo.width.toLocaleString()} × {photo.height.toLocaleString()}</dd></div>
        <div><dt>파일</dt><dd>{formatBytes(photo.size_bytes)}</dd></div>
      </dl>
      <div className="photo-path" title={photo.path}><Info size={13} />{photo.relative_path}</div>
    </article>
  );
}

function TrashDialog({
  count,
  bytes,
  partial,
  fullyMarkedGroupCount,
  loading,
  onCancel,
  onConfirm,
}: {
  count: number;
  bytes: number;
  partial: boolean;
  fullyMarkedGroupCount: number;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !loading) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="trash-title">
        <button className="modal-close" aria-label="닫기" onClick={onCancel} disabled={loading}><X size={18} /></button>
        <div className="modal-icon"><Trash size={24} weight="duotone" /></div>
        <h2 id="trash-title">{count.toLocaleString()}장을 휴지통으로 옮길까요?</h2>
        <p>
          {partial ? "현재 그룹까지 검토한 삭제 후보만 이동합니다. 뒤쪽의 미검토 그룹은 그대로 남습니다. " : ""}
          선택한 사진의 전체 용량은 약 {formatBytes(bytes)}입니다. 파일은 휴지통에서 복원할 수 있습니다.
        </p>
        {fullyMarkedGroupCount > 0 ? (
          <div className="safety-note destructive"><WarningCircle size={17} weight="fill" />{fullyMarkedGroupCount}개 그룹은 사진이 한 장도 남지 않습니다.</div>
        ) : (
          <div className="safety-note"><ShieldCheck size={17} weight="fill" />정리 후보가 아닌 사진은 그대로 남습니다.</div>
        )}
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onCancel} disabled={loading}>취소</button>
          <button className="button button-danger" onClick={onConfirm} disabled={loading}><Trash size={16} weight="fill" />{loading ? "옮기는 중" : partial ? "여기까지 이동" : fullyMarkedGroupCount > 0 ? "전부 포함해 이동" : "휴지통으로 이동"}</button>
        </div>
      </div>
    </div>
  );
}

function CacheDialog({
  cache,
  loading,
  resetting,
  canReset,
  onCancel,
  onReset,
}: {
  cache: CalculationCache | null;
  loading: boolean;
  resetting: boolean;
  canReset: boolean;
  onCancel: () => void;
  onReset: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !resetting) onCancel(); }}>
      <div className="modal cache-modal" role="dialog" aria-modal="true" aria-labelledby="cache-title">
        <button className="modal-close" aria-label="닫기" onClick={onCancel} disabled={resetting}><X size={18} /></button>
        <div className="modal-icon cache"><Database size={24} weight="duotone" /></div>
        <h2 id="cache-title">이미지 계산 캐시</h2>
        {loading || !cache ? (
          <p className="cache-loading">캐시 목록을 불러오는 중입니다.</p>
        ) : (
          <>
            <p>
              분석값 {cache.analysis_entry_count.toLocaleString()}개를 검사한 폴더 {cache.analysis_groups.length.toLocaleString()}개 묶음으로 표시합니다.
              미리보기 {cache.preview_entry_count.toLocaleString()}개와 분석 결과 {cache.session_count.toLocaleString()}건도 메모리에 있습니다.
            </p>
            <div className="cache-group-list" role="list" aria-label="검사 폴더별 이미지 계산 캐시">
              {cache.analysis_groups.length ? cache.analysis_groups.map((group) => (
                <div className="cache-group-row" role="listitem" key={group.path} title={group.path}>
                  <FolderOpen size={17} />
                  <span><strong>{group.name}</strong><small>{group.path}</small></span>
                  <em>{group.entry_count.toLocaleString()}개</em>
                </div>
              )) : (
                <div className="cache-empty">검사 폴더의 이미지 계산값이 없습니다.</div>
              )}
            </div>
          </>
        )}
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onCancel} disabled={resetting}>닫기</button>
          <button className="button button-danger-soft" onClick={onReset} disabled={loading || resetting || !canReset}>
            <ArrowCounterClockwise size={16} />{resetting ? "초기화 중" : "전체 캐시 초기화"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StorageDialog({
  count,
  bytes,
  destination,
  loading,
  onCancel,
  onConfirm,
}: {
  count: number;
  bytes: number;
  destination: string;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !loading) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="storage-title">
        <button className="modal-close" aria-label="닫기" onClick={onCancel} disabled={loading}><X size={18} /></button>
        <div className="modal-icon storage"><FolderOpen size={24} weight="duotone" /></div>
        <h2 id="storage-title">보관 사진 {count.toLocaleString()}장을 옮길까요?</h2>
        <p>
          약 {formatBytes(bytes)}의 사진을 복사하지 않고 다음 위치로 이동합니다.
          <strong className="storage-destination">{destination}/Photos/YYYYMMDD</strong>
        </p>
        <div className="safety-note"><ShieldCheck size={17} weight="fill" />촬영 날짜별 폴더를 만들며 기존 파일은 덮어쓰지 않습니다.</div>
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onCancel} disabled={loading}>취소</button>
          <button className="button button-primary" onClick={onConfirm} disabled={loading}>
            <FolderOpen size={16} />{loading ? "옮기는 중" : "보관 위치로 이동"}
          </button>
        </div>
      </div>
    </div>
  );
}
