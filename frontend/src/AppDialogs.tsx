import { ArrowCounterClockwise, ArrowUp, CaretRight, Check, CircleNotch, Database, FolderOpen, ShieldCheck, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { CalculationCache, FolderBrowserData } from "./appTypes";
import { api, formatBytes } from "./appUtils";

export function FolderBrowserDialog({
  initialSelected,
  onCancel,
  onConfirm,
}: {
  initialSelected: string[];
  onCancel: () => void;
  onConfirm: (folders: string[]) => void;
}) {
  const [browser, setBrowser] = useState<FolderBrowserData | null>(null);
  const [selected, setSelected] = useState(() => [...initialSelected]);
  const [loading, setLoading] = useState(true);
  const [browseError, setBrowseError] = useState<string | null>(null);

  async function loadFolder(path?: string, reveal = false): Promise<boolean> {
    setLoading(true);
    setBrowseError(null);
    try {
      const query = path ? `?${reveal ? "reveal" : "path"}=${encodeURIComponent(path)}` : "";
      const nextBrowser = await api<FolderBrowserData>(`/api/folders/browse${query}`);
      setBrowser(nextBrowser);
      if (reveal && nextBrowser.revealed && path !== nextBrowser.revealed) {
        setSelected((previous) => [
          ...new Set(previous.map((item) => item === path ? nextBrowser.revealed! : item)),
        ]);
      }
      return true;
    } catch (loadError) {
      setBrowseError(loadError instanceof Error ? loadError.message : "폴더를 열지 못했습니다.");
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      if (!await loadFolder(initialSelected[0], true)) await loadFolder();
    })();
  }, []);

  function toggleFolder(path: string) {
    setSelected((previous) => (
      previous.includes(path)
        ? previous.filter((item) => item !== path)
        : [...previous, path]
    ));
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="modal folder-browser-modal" role="dialog" aria-modal="true" aria-labelledby="folder-browser-title">
        <button className="modal-close" aria-label="닫기" onClick={onCancel}><X size={18} /></button>
        <div className="folder-browser-heading">
          <div className="modal-icon storage"><FolderOpen size={24} weight="duotone" /></div>
          <div>
            <h2 id="folder-browser-title">사진 폴더 선택</h2>
            <p>폴더를 탐색하면서 필요한 위치를 여러 개 체크하세요.</p>
          </div>
        </div>

        {browser?.shortcuts.length ? (
          <div className="folder-shortcuts" aria-label="빠른 위치">
            {browser.shortcuts.map((shortcut) => (
              <button key={shortcut.path} type="button" onClick={() => loadFolder(shortcut.path)} disabled={loading}>
                {shortcut.name}
              </button>
            ))}
          </div>
        ) : null}

        <div className="folder-location-bar">
          <button type="button" aria-label="상위 폴더로 이동" onClick={() => browser?.parent && loadFolder(browser.parent)} disabled={loading || !browser?.parent}>
            <ArrowUp size={16} />
          </button>
          <span title={browser?.path}>{browser?.path || "폴더를 불러오는 중"}</span>
        </div>

        {browseError ? (
          <div className="folder-browser-error" role="alert"><WarningCircle size={17} weight="fill" />{browseError}</div>
        ) : (
          <div className="folder-browser-list" aria-label="하위 폴더 목록">
            {browser && (
              <label className={`folder-browser-row current ${selected.includes(browser.path) ? "selected" : ""}`}>
                <input type="checkbox" checked={selected.includes(browser.path)} onChange={() => toggleFolder(browser.path)} />
                <FolderOpen size={17} weight="fill" />
                <span><strong>현재 폴더</strong><small>{browser.path}</small></span>
              </label>
            )}
            {loading ? (
              <div className="folder-browser-empty"><CircleNotch className="active-status-spinner" size={18} />폴더를 불러오는 중</div>
            ) : browser?.folders.length ? browser.folders.map((item) => (
              <div className={`folder-browser-row ${selected.includes(item.path) ? "selected" : ""}`} key={item.path}>
                <input
                  type="checkbox"
                  aria-label={`${item.name} 선택`}
                  checked={selected.includes(item.path)}
                  onChange={() => toggleFolder(item.path)}
                />
                <FolderOpen size={17} />
                <button type="button" onClick={() => loadFolder(item.path)} title={item.path}>{item.name}</button>
                <button className="folder-open-button" type="button" aria-label={`${item.name} 열기`} onClick={() => loadFolder(item.path)}>
                  <CaretRight size={16} />
                </button>
              </div>
            )) : (
              <div className="folder-browser-empty">하위 폴더가 없습니다.</div>
            )}
          </div>
        )}

        <div className="folder-selection-summary" aria-live="polite">
          <span><strong>{selected.length}</strong>개 폴더 선택됨</span>
          {selected.length > 0 && <button type="button" onClick={() => setSelected([])}>모두 해제</button>}
        </div>
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onCancel}>취소</button>
          <button className="button button-primary" onClick={() => onConfirm(selected)}>
            <Check size={16} weight="bold" />선택 완료
          </button>
        </div>
      </div>
    </div>
  );
}
export function TrashDialog({
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

export function CacheDialog({
  cache,
  loading,
  resetting,
  deletingFolder,
  canReset,
  onCancel,
  onDelete,
  onReset,
}: {
  cache: CalculationCache | null;
  loading: boolean;
  resetting: boolean;
  deletingFolder: string | null;
  canReset: boolean;
  onCancel: () => void;
  onDelete: (folder: string) => void;
  onReset: () => void;
}) {
  const busy = resetting || deletingFolder !== null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <div className="modal cache-modal" role="dialog" aria-modal="true" aria-labelledby="cache-title">
        <button className="modal-close" aria-label="닫기" onClick={onCancel} disabled={busy}><X size={18} /></button>
        <div className="modal-icon cache"><Database size={24} weight="duotone" /></div>
        <h2 id="cache-title">이미지 계산 캐시</h2>
        {loading || !cache ? (
          <p className="cache-loading">캐시 목록을 불러오는 중입니다.</p>
        ) : (
          <>
            <p>
              현재 확인 가능한 메모리 사용량은 약 {formatBytes(cache.total_bytes)}입니다.
              실제 파일 위치별로 분석값, 미리보기와 완료된 분석 결과를 모두 합산했습니다.
            </p>
            <div className="cache-summary" aria-label="메모리 항목 요약">
              <span>분석값 <strong>{cache.analysis_entry_count.toLocaleString()}</strong></span>
              <span>미리보기 <strong>{cache.preview_entry_count.toLocaleString()}</strong></span>
              <span>결과 사진 <strong>{cache.result_entry_count.toLocaleString()}</strong></span>
            </div>
            <div className="cache-group-list" role="list" aria-label="실제 폴더별 메모리 사용량">
              {cache.groups.length ? cache.groups.map((group) => (
                <div className="cache-group-row" role="listitem" key={group.path} title={group.path}>
                  <FolderOpen size={17} />
                  <span>
                    <strong>{group.name}</strong>
                    <small>{group.path}</small>
                    <small className="cache-breakdown">
                      분석 {group.analysis_count.toLocaleString()} · 미리보기 {group.preview_count.toLocaleString()} · 결과 {group.result_count.toLocaleString()}
                    </small>
                  </span>
                  <div className="cache-group-actions">
                    <em>{formatBytes(group.total_bytes)}</em>
                    <button
                      type="button"
                      aria-label={`${group.name} 캐시 삭제`}
                      title="이 폴더의 캐시만 삭제"
                      onClick={() => onDelete(group.path)}
                      disabled={!canReset || busy}
                    >
                      {deletingFolder === group.path ? <CircleNotch size={15} className="spin" /> : <Trash size={15} />}
                    </button>
                  </div>
                </div>
              )) : (
                <div className="cache-empty">현재 메모리에 남아 있는 이미지 관련 항목이 없습니다.</div>
              )}
            </div>
          </>
        )}
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onCancel} disabled={busy}>닫기</button>
          <button className="button button-danger-soft" onClick={onReset} disabled={loading || busy || !canReset}>
            <ArrowCounterClockwise size={16} />{resetting ? "초기화 중" : "전체 캐시 초기화"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function StorageDialog({
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
