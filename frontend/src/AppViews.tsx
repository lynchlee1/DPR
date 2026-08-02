import { CheckCircle, FolderOpen, ImageSquare, Lightning, MagnifyingGlass, ShieldCheck, Sparkle, WarningCircle } from "@phosphor-icons/react";
import type { AnalysisMode, CleanupOutcome, ScanResult, Session, StorageOutcome } from "./appTypes";
import { formatBytes, formatSelectedPeriod, shortPath } from "./appUtils";

export function WelcomeView({
  onChoose,
  onScan,
  folderCount,
  mode,
  threshold,
  includeSubfolders,
}: {
  onChoose: () => void;
  onScan: () => void;
  folderCount: number;
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
        <button className="button button-secondary" onClick={onChoose}><FolderOpen size={17} />폴더 추가 선택</button>
        <button className="button button-primary" onClick={onScan} disabled={!folderCount}>
          {mode === "quick" ? <Lightning size={17} weight="fill" /> : <Sparkle size={17} weight="fill" />}
          {mode === "quick" ? "빠른 분석" : "분석 시작"}
        </button>
      </div>
      <div className="workflow-notes">
        <div><span>1</span><strong>사진 찾기</strong><small>{folderCount > 1 ? `${folderCount}개 폴더` : includeSubfolders ? "하위 폴더 포함" : "선택한 폴더만"}</small></div>
        <div><span>2</span><strong>유사 사진 모으기</strong><small>한눈에 비교</small></div>
        <div><span>3</span><strong>확인 후 정리</strong><small>휴지통으로 이동</small></div>
      </div>
    </div>
  );
}

export function ScanningView({ session }: { session: Session }) {
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
        <div><h1>{phaseLabel}</h1><p>{session.folders && session.folders.length > 1 ? `${session.folders.length}개 폴더를 함께 분석 중` : shortPath(session.folder)}</p></div>
        <strong>{progress}%</strong>
      </div>
      <div className={`progress-track ${session.total ? "" : "indeterminate"}`}>
        <span style={session.total ? { transform: `scaleX(${progress / 100})` } : undefined} />
      </div>
      <p className="progress-detail">{session.total ? `${session.completed.toLocaleString()} / ${session.total.toLocaleString()} 처리` : "분석할 파일을 확인하고 있습니다"}</p>
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

export function EmptyResults({ result, onRescan }: { result: ScanResult; onRescan: () => void }) {
  return (
    <div className="welcome-view">
      <div className="welcome-icon success"><CheckCircle size={40} weight="duotone" /></div>
      <h1>정리할 유사 사진이 없습니다</h1>
      <p>{result.stats.source_folders.toLocaleString()}개 폴더의 사진 {result.stats.analyzed.toLocaleString()}장을 확인했지만 현재 {result.threshold}% 기준에 맞는 유사 사진을 찾지 못했습니다.</p>
      <button className="button button-secondary" onClick={onRescan}>설정을 바꿔 다시 분석</button>
    </div>
  );
}

export function HiddenVideosView({
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

export function HiddenSingletonsView({
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

export function StorageCompletionView({
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
      <div className={`source-check ${outcome.source_check.is_empty ? "is-empty" : "has-files"}`}>
        <ShieldCheck size={20} weight="duotone" aria-hidden="true" />
        <div>
          <strong>
            {outcome.source_check.errors.length
              ? "원본 디렉터리 검사를 완료하지 못했습니다"
              : outcome.source_check.is_empty
                ? "원본 디렉터리가 비어 있습니다"
                : `원본 디렉터리에 파일 ${outcome.source_check.file_count.toLocaleString()}개가 남아 있습니다`}
          </strong>
          <span>남은 용량 {formatBytes(outcome.source_check.size_bytes)}</span>
          {outcome.source_check.directories.map((directory) => (
            <small key={directory.path} title={directory.path}>
              {shortPath(directory.path)} · {directory.file_count.toLocaleString()}개 · {formatBytes(directory.size_bytes)}
            </small>
          ))}
        </div>
      </div>
      <button className="button button-primary" onClick={onStartOver}>새 폴더 정리</button>
    </div>
  );
}

export function CompletionView({ outcome, onStartOver }: { outcome: CleanupOutcome; onStartOver: () => void }) {
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
