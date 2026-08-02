import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, FolderOpen, Info, Keyboard, Trash, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { AnalysisMode, Photo, PhotoGroup } from "./appTypes";
import { formatBytes, formatDate, imageUrl } from "./appUtils";

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

export function ReviewWorkspace(props: ReviewProps) {
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
