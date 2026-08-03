import { useEffect, useMemo, useRef, useState } from "react";
import type { GuideState } from "./GuideOverlay";
import type {
  AnalysisMode,
  CacheDeleteOutcome,
  CalculationCache,
  CleanupOutcome,
  DateOrder,
  PhotoGroup,
  ScanResult,
  Session,
  StorageOutcome,
} from "./appTypes";
import {
  api,
  clearCandidateMarks,
  filterReviewGroups,
  firstReviewPhoto,
  imageUrl,
  removeMovedPhotos,
} from "./appUtils";
import {
  ARROW_REPEAT_INTERVAL_KEY,
  CLEANUP_JSON_KEY,
  DEFAULT_ARROW_REPEAT_INTERVAL,
  DEFAULT_QUICK_THRESHOLD,
  REVIEW_GUIDE_KEY,
  SETUP_GUIDE_KEY,
  SHOW_SINGLETONS_KEY,
} from "./appConstants";

export function useAppController() {
  const [folder, setFolder] = useState(() => localStorage.getItem("photo-sorter-folder") || "");
  const [folders, setFolders] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("photo-sorter-folders") || "[]");
      if (Array.isArray(stored) && stored.every((item) => typeof item === "string")) return stored;
    } catch {
      // Fall back to the legacy single-folder preference.
    }
    return folder ? [folder] : [];
  });
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
  const [isFolderBrowserOpen, setIsFolderBrowserOpen] = useState(false);
  const [isPickingDestination, setIsPickingDestination] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const [isCacheDialogOpen, setIsCacheDialogOpen] = useState(false);
  const [isCacheLoading, setIsCacheLoading] = useState(false);
  const [deletingCacheFolder, setDeletingCacheFolder] = useState<string | null>(null);
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
  const selectedFolders = folders.length > 0 ? folders : folder.trim() ? [folder.trim()] : [];
  const activeStatus = isCancelling
    ? "작업을 중단하는 중"
    : isStoring
      ? "보관 사진을 이동하는 중"
      : isTrashing
        ? "선택한 사진을 휴지통으로 이동하는 중"
        : isScanning
          ? session?.phase === "indexing"
            ? "사진 촬영일을 확인하는 중"
            : session?.phase === "comparing"
              ? "비슷한 사진을 비교하는 중"
              : "사진을 분석하는 중"
          : null;
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
      if (!result || isTrashDialogOpen || isStorageDialogOpen || isFolderBrowserOpen || guide) return;
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

  function updateManualFolder(value: string) {
    setFolder(value);
    const nextFolders = value.trim() ? [value.trim()] : [];
    setFolders(nextFolders);
    if (nextFolders.length) {
      localStorage.setItem("photo-sorter-folder", nextFolders[0]);
      localStorage.setItem("photo-sorter-folders", JSON.stringify(nextFolders));
    } else {
      localStorage.removeItem("photo-sorter-folder");
      localStorage.removeItem("photo-sorter-folders");
    }
  }

  function removeFolder(path: string) {
    const nextFolders = selectedFolders.filter((item) => item !== path);
    setFolders(nextFolders);
    setFolder(nextFolders[0] || "");
    if (nextFolders.length) {
      localStorage.setItem("photo-sorter-folder", nextFolders[0]);
      localStorage.setItem("photo-sorter-folders", JSON.stringify(nextFolders));
    } else {
      localStorage.removeItem("photo-sorter-folder");
      localStorage.removeItem("photo-sorter-folders");
    }
    setResult(null);
    setSession(null);
  }

  function clearFolders() {
    setFolders([]);
    setFolder("");
    localStorage.removeItem("photo-sorter-folder");
    localStorage.removeItem("photo-sorter-folders");
    setResult(null);
    setSession(null);
  }

  function applyFolders(nextFolders: string[]) {
    const uniqueFolders = [...new Set(nextFolders)];
    setFolders(uniqueFolders);
    setFolder(uniqueFolders[0] || "");
    if (uniqueFolders.length) {
      localStorage.setItem("photo-sorter-folder", uniqueFolders[0]);
      localStorage.setItem("photo-sorter-folders", JSON.stringify(uniqueFolders));
    } else {
      localStorage.removeItem("photo-sorter-folder");
      localStorage.removeItem("photo-sorter-folders");
    }
    setResult(null);
    setSession(null);
    setCleanupOutcome(null);
    setStorageOutcome(null);
    setIsFolderBrowserOpen(false);
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

  async function deleteCacheFolder(folderPath: string) {
    const confirmed = window.confirm(
      `${folderPath}\n\n이 폴더의 분석값, 미리보기와 완료된 분석 결과를 메모리에서 삭제할까요? 원본 파일은 삭제되지 않습니다.`,
    );
    if (!confirmed) return;

    setDeletingCacheFolder(folderPath);
    setError(null);
    setResetNotice(null);
    try {
      const outcome = await api<CacheDeleteOutcome>("/api/calculations/cache", {
        method: "DELETE",
        body: JSON.stringify({ folder: folderPath }),
      });
      if (session && outcome.removed_session_ids.includes(session.id)) {
        setSession(null);
        setResult(null);
        setSelectedGroupIndex(0);
        setSelectedPhotoId(null);
        setCleanupOutcome(null);
        setStorageOutcome(null);
      }
      setCalculationCache(await api<CalculationCache>("/api/calculations/cache"));
      const removedCount = outcome.removed_analysis_entries
        + outcome.removed_preview_entries
        + outcome.removed_result_entries;
      setResetNotice(`${folderPath}의 메모리 항목 ${removedCount.toLocaleString()}개를 삭제했습니다.`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "개별 캐시를 삭제하지 못했습니다.");
    } finally {
      setDeletingCacheFolder(null);
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
      localStorage.setItem("photo-sorter-folder", selectedFolders[0]);
      localStorage.setItem("photo-sorter-folders", JSON.stringify(selectedFolders));
      const next = await api<Session>("/api/scans", {
        method: "POST",
        body: JSON.stringify({
          folder,
          folders: selectedFolders,
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


  return {
    folder, destination, threshold, quickThreshold, analysisMode,
    includeSubfolders, cleanupJsonFiles, dayLimit, dateOrder, showSingletons,
    arrowRepeatInterval, isAdvancedOpen, session, result, selectedGroupIndex,
    selectedPhotoId, isFolderBrowserOpen, isPickingDestination, isResetting,
    resetNotice, isCacheDialogOpen, isCacheLoading, deletingCacheFolder, calculationCache,
    isTrashDialogOpen, trashThroughGroupIndex, isTrashing, cleanupOutcome,
    isStorageDialogOpen, isStoring, isCancelling, storageOutcome, error, guide,
    helpButtonRef, isScanning, isMoving, selectedFolders, activeStatus,
    visibleGroups, currentGroup, selectedPhoto, markedPhotos, keptPhotos,
    hiddenVideos, hiddenSingletonPhotoCount, markedBytes, keptBytes,
    pendingTrashPhotos, pendingTrashBytes, fullyMarkedGroupCount,
    throughCurrentMarkedPhotos, throughCurrentMarkedBytes, activeThreshold,
    isDayLimitValid, advancedSummary,
    setDestination, setThreshold, setQuickThreshold, setAnalysisMode,
    setIncludeSubfolders, setCleanupJsonFiles, setDayLimit, setDateOrder,
    setArrowRepeatInterval, setIsAdvancedOpen, setSession, setResult,
    setSelectedPhotoId, setIsFolderBrowserOpen, setResetNotice,
    setIsCacheDialogOpen, setIsTrashDialogOpen, setTrashThroughGroupIndex,
    setCleanupOutcome, setIsStorageDialogOpen, setStorageOutcome, setError,
    setGuide, updateManualFolder, removeFolder, clearFolders, applyFolders,
    pickDestination, openCacheDialog, deleteCacheFolder, resetCalculations, startScan,
    stopActiveOperation, selectGroup, toggleMarked, applySwipeDecision,
    markCurrentGroup, updateSingletonVisibility, openTrashDialog,
    openStorageDialog, closeGuide, changeGuide, storeKeptPhotos, trashMarked,
  };
}
