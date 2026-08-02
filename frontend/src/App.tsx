import {
  ArrowCounterClockwise,
  ArrowDown,
  ArrowUp,
  CaretDown,
  CheckCircle,
  CircleNotch,
  Database,
  FolderOpen,
  ImageSquare,
  Lightning,
  MagnifyingGlass,
  Question,
  Sparkle,
  Stop,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { GuideOverlay } from "./GuideOverlay";
import {
  CompletionView,
  EmptyResults,
  HiddenSingletonsView,
  HiddenVideosView,
  ScanningView,
  StorageCompletionView,
  WelcomeView,
} from "./AppViews";
import { CacheDialog, FolderBrowserDialog, StorageDialog, TrashDialog } from "./AppDialogs";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { formatBytes, formatSelectedPeriod, imageUrl, shortPath } from "./appUtils";
import { useAppController } from "./useAppController";
import { ARROW_REPEAT_INTERVAL_KEY, CLEANUP_JSON_KEY } from "./appConstants";

export function App() {
  const {
    folder, destination, analysisMode, includeSubfolders, cleanupJsonFiles,
    dayLimit, dateOrder, showSingletons, arrowRepeatInterval, isAdvancedOpen,
    session, result, selectedGroupIndex, isFolderBrowserOpen,
    isPickingDestination, isResetting, resetNotice, isCacheDialogOpen,
    isCacheLoading, calculationCache, isTrashDialogOpen,
    trashThroughGroupIndex, isTrashing, cleanupOutcome, isStorageDialogOpen,
    isStoring, isCancelling, storageOutcome, error, guide, helpButtonRef,
    isScanning, isMoving, selectedFolders, activeStatus, visibleGroups,
    currentGroup, selectedPhoto, markedPhotos, keptPhotos, hiddenVideos,
    hiddenSingletonPhotoCount, markedBytes, keptBytes, pendingTrashPhotos,
    pendingTrashBytes, fullyMarkedGroupCount, throughCurrentMarkedPhotos,
    throughCurrentMarkedBytes, activeThreshold, isDayLimitValid,
    advancedSummary, setDestination, setThreshold, setQuickThreshold,
    setAnalysisMode, setIncludeSubfolders, setCleanupJsonFiles, setDayLimit,
    setDateOrder, setArrowRepeatInterval, setIsAdvancedOpen, setSession,
    setResult, setSelectedPhotoId, setIsFolderBrowserOpen, setResetNotice,
    setIsCacheDialogOpen, setIsTrashDialogOpen, setTrashThroughGroupIndex,
    setCleanupOutcome, setIsStorageDialogOpen, setStorageOutcome, setError,
    setGuide, updateManualFolder, removeFolder, clearFolders, applyFolders,
    pickDestination, openCacheDialog, resetCalculations, startScan,
    stopActiveOperation, selectGroup, toggleMarked, applySwipeDecision,
    markCurrentGroup, updateSingletonVisibility, openTrashDialog,
    openStorageDialog, closeGuide, changeGuide, storeKeptPhotos, trashMarked,
  } = useAppController();

  return (
    <div className="app-shell">
      <header className={`titlebar ${activeStatus ? "is-active" : ""}`}>
        <div className="app-identity">
          <span className="app-mark"><ImageSquare size={19} weight="fill" /></span>
          <span className="app-name">사진 정리</span>
        </div>
        {activeStatus && (
          <div className="active-status" role="status" aria-live="polite">
            <CircleNotch className="active-status-spinner" size={16} weight="bold" aria-hidden="true" />
            <span className="active-status-copy"><small>실행 중</small><span>{activeStatus}</span></span>
            {isScanning && session?.total ? (
              <strong>{Math.round((session.completed / session.total) * 100)}%</strong>
            ) : null}
          </div>
        )}
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
          <button className="button button-secondary compact" onClick={() => setIsFolderBrowserOpen(true)} disabled={isScanning || isMoving}>
            <FolderOpen size={16} />
            폴더 선택
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
              {storageOutcome.source_check.errors.length
                ? " 원본 디렉터리 잔여 파일 검사를 완료하지 못했습니다."
                : storageOutcome.source_check.is_empty
                  ? " 원본 디렉터리에 남은 파일이 없습니다."
                  : ` 원본 디렉터리 잔여 ${storageOutcome.source_check.file_count.toLocaleString()}개 · ${formatBytes(storageOutcome.source_check.size_bytes)}`}
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
                onChange={(event) => updateManualFolder(event.target.value)}
                spellCheck={false}
                disabled={isScanning}
              />
              <button className="icon-button" aria-label="앱에서 폴더 선택" onClick={() => setIsFolderBrowserOpen(true)} disabled={isScanning}>
                <FolderOpen size={18} />
              </button>
            </div>
            <button className="folder-browser-trigger" type="button" onClick={() => setIsFolderBrowserOpen(true)} disabled={isScanning}>
              <FolderOpen size={15} />앱에서 여러 폴더 선택
            </button>
            {selectedFolders.length > 0 && (
              <div className="selected-folders" aria-label={`선택한 폴더 ${selectedFolders.length}개`}>
                <div className="selected-folders-heading">
                  <span>{selectedFolders.length}개 폴더 선택됨</span>
                  <button type="button" onClick={clearFolders} disabled={isScanning}>전체 해제</button>
                </div>
                {selectedFolders.map((path) => (
                  <div className="selected-folder" key={path} title={path}>
                    <FolderOpen size={14} aria-hidden="true" />
                    <span>{shortPath(path)}</span>
                    <button type="button" aria-label={`${path} 선택 해제`} onClick={() => removeFolder(path)} disabled={isScanning}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}

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

            <button className="button button-primary scan-button" onClick={startScan} disabled={isScanning || selectedFolders.length === 0 || !isDayLimitValid} data-guide="scan">
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
              onChoose={() => setIsFolderBrowserOpen(true)}
              onScan={startScan}
              folderCount={selectedFolders.length}
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

      {isFolderBrowserOpen && (
        <FolderBrowserDialog
          initialSelected={selectedFolders}
          onCancel={() => setIsFolderBrowserOpen(false)}
          onConfirm={applyFolders}
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
