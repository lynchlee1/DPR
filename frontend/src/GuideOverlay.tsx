import {
  ArrowLeft,
  ArrowRight,
  Check,
  FolderOpen,
  Keyboard,
  Lightning,
  MagnifyingGlass,
  ShieldCheck,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

export type GuideKind = "menu" | "setup" | "review" | "shortcuts";

export type GuideState = {
  kind: GuideKind;
  step: number;
};

type GuideStep = {
  target: string;
  title: string;
  copy: string;
};

type TargetRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

const SETUP_STEPS: GuideStep[] = [
  {
    target: '[data-guide="folder"]',
    title: "정리할 사진 폴더를 선택하세요",
    copy: "폴더 안의 하위 폴더도 함께 확인합니다. 경로를 직접 입력하거나 폴더 버튼을 사용할 수 있습니다.",
  },
  {
    target: '[data-guide="mode"]',
    title: "일반 분석과 빠른 분석의 차이",
    copy: "일반 분석은 비슷한 사진만 묶고 삭제 후보는 정하지 않습니다. 사진마다 직접 보관 여부를 선택할 때 적합합니다. 빠른 분석은 그룹에서 가장 최근에 촬영한 사진을 보존 대상으로 추천하고, 나머지는 삭제 후보로 미리 표시합니다. 추천을 확인하며 그룹별로 빠르게 정리할 때 적합합니다.",
  },
  {
    target: '[data-guide="advanced"]',
    title: "필요할 때 세부 설정을 여세요",
    copy: "하위 폴더, 분석 날짜 수와 방향, 유사도 기준은 여기에 모여 있습니다. 현재 값은 접힌 상태에서도 확인할 수 있습니다.",
  },
  {
    target: '[data-guide="scan"]',
    title: "사진 분석을 시작하세요",
    copy: "분석 중에도 사진은 외부로 전송되지 않습니다. 이 단계에서는 파일을 이동하지 않습니다.",
  },
];

const REVIEW_STEPS: GuideStep[] = [
  {
    target: '[data-guide="groups"]',
    title: "검토할 그룹을 선택하세요",
    copy: "왼쪽 목록에서 그룹을 고릅니다. 오른쪽 숫자는 현재 그룹에서 선택한 삭제 후보 수입니다.",
  },
  {
    target: '[data-guide="review-toolbar"]',
    title: "그룹 사이를 이동하세요",
    copy: "화살표 버튼이나 키보드 왼쪽, 오른쪽 화살표로 이동합니다. 빠른 분석에서는 추천 보존 수도 함께 표시됩니다.",
  },
  {
    target: '[data-guide="swipe"]',
    title: "사진을 보관하거나 후보로 표시하세요",
    copy: "사진을 위로 밀면 보관, 아래로 밀면 삭제 후보가 됩니다. 사진을 눌러 선택한 뒤 아래 버튼을 사용해도 됩니다.",
  },
  {
    target: '[data-guide="filmstrip"]',
    title: "한 그룹을 빠르게 정리하세요",
    copy: "작은 사진으로 선택을 바꾸고, 전부 보관 또는 전부 후보를 사용해 그룹 전체를 한 번에 변경할 수 있습니다.",
  },
  {
    target: '[data-guide="cleanup"]',
    title: "후보를 확인한 뒤 이동하세요",
    copy: "후보 수와 용량을 확인합니다. 빠른 분석은 현재 그룹까지, 일반 분석은 선택한 전체 후보를 휴지통으로 이동합니다.",
  },
];

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="shortcut-row">
      <span className="shortcut-keys">{keys.map((key) => <kbd key={key}>{key}</kbd>)}</span>
      <span>{label}</span>
    </div>
  );
}

export function GuideOverlay({
  guide,
  hasReview,
  onChange,
  onClose,
}: {
  guide: GuideState;
  hasReview: boolean;
  onChange: (guide: GuideState) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | undefined>();
  const steps = guide.kind === "setup" ? SETUP_STEPS : guide.kind === "review" ? REVIEW_STEPS : [];
  const currentStep = steps[guide.step];

  useEffect(() => {
    headingRef.current?.focus();
  }, [guide.kind, guide.step]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === headingRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useLayoutEffect(() => {
    if (!currentStep) {
      setTargetRect(null);
      return;
    }
    const target = document.querySelector<HTMLElement>(currentStep.target);
    if (!target) {
      setTargetRect(null);
      return;
    }
    const targetElement = target;

    function measure() {
      const rect = targetElement.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        setTargetRect(null);
        return;
      }
      const padding = 6;
      const left = Math.max(8, Math.min(window.innerWidth - 8, rect.left - padding));
      const right = Math.max(8, Math.min(window.innerWidth - 8, rect.right + padding));
      const top = Math.max(8, Math.min(window.innerHeight - 8, rect.top - padding));
      const bottom = Math.max(8, Math.min(window.innerHeight - 8, rect.bottom + padding));
      setTargetRect({
        top,
        left,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      });
    }

    const initialRect = targetElement.getBoundingClientRect();
    if (initialRect.top < 0 || initialRect.bottom > window.innerHeight) {
      targetElement.scrollIntoView({ block: "center" });
    }
    const frame = window.requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(targetElement);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [currentStep]);

  useLayoutEffect(() => {
    if (!targetRect || !panelRef.current || window.innerWidth <= 760) {
      setPopoverStyle(undefined);
      return;
    }
    const panel = panelRef.current;
    const activeTargetRect = targetRect;

    function placePopover() {
      const panelRect = panel.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const edge = 12;
      const gap = 14;
      const maxLeft = Math.max(edge, viewportWidth - panelRect.width - edge);
      const maxTop = Math.max(edge, viewportHeight - panelRect.height - edge);
      const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), maximum);
      const alignedTop = clamp(activeTargetRect.top, edge, maxTop);
      const centeredLeft = clamp(activeTargetRect.left + activeTargetRect.width / 2 - panelRect.width / 2, edge, maxLeft);

      const right = activeTargetRect.left + activeTargetRect.width + gap;
      if (right + panelRect.width <= viewportWidth - edge) {
        setPopoverStyle({ left: right, top: alignedTop });
        return;
      }

      const left = activeTargetRect.left - panelRect.width - gap;
      if (left >= edge) {
        setPopoverStyle({ left, top: alignedTop });
        return;
      }

      const below = activeTargetRect.top + activeTargetRect.height + gap;
      if (below + panelRect.height <= viewportHeight - edge) {
        setPopoverStyle({ left: centeredLeft, top: below });
        return;
      }

      const above = activeTargetRect.top - panelRect.height - gap;
      if (above >= edge) {
        setPopoverStyle({ left: centeredLeft, top: above });
        return;
      }

      setPopoverStyle({
        left: centeredLeft,
        top: clamp(activeTargetRect.top + activeTargetRect.height / 2 - panelRect.height / 2, edge, maxTop),
      });
    }

    const frame = window.requestAnimationFrame(placePopover);
    const observer = new ResizeObserver(placePopover);
    observer.observe(panel);
    window.addEventListener("resize", placePopover);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", placePopover);
    };
  }, [targetRect, guide.kind, guide.step]);

  const spotlightStyle = targetRect
    ? ({
        "--guide-top": `${targetRect.top}px`,
        "--guide-left": `${targetRect.left}px`,
        "--guide-width": `${targetRect.width}px`,
        "--guide-height": `${targetRect.height}px`,
      } as CSSProperties)
    : undefined;
  function previousStep() {
    if (guide.step > 0) onChange({ ...guide, step: guide.step - 1 });
  }

  function nextStep() {
    if (guide.step < steps.length - 1) {
      onChange({ ...guide, step: guide.step + 1 });
      return;
    }
    if (guide.kind === "review") {
      onChange({ kind: "shortcuts", step: 0 });
      return;
    }
    onClose();
  }

  return (
    <div className={`guide-overlay ${targetRect ? "has-target" : ""}`} role="dialog" aria-modal="true" aria-labelledby="guide-title">
      {targetRect && <div className="guide-spotlight" style={spotlightStyle} aria-hidden="true" />}

      {guide.kind === "menu" ? (
        <div className="guide-dialog guide-menu" ref={panelRef}>
          <button className="guide-close" aria-label="사용법 닫기" onClick={onClose}><X size={18} /></button>
          <div className="guide-icon"><ShieldCheck size={25} weight="duotone" /></div>
          <h2 id="guide-title" ref={headingRef} tabIndex={-1}>어떤 사용법을 볼까요?</h2>
          <p>필요한 안내를 선택하면 현재 화면 위에서 해당 기능을 차례대로 보여드립니다.</p>
          <div className="guide-menu-actions">
            <button className="guide-menu-item" onClick={() => onChange({ kind: "setup", step: 0 })}>
              <span><FolderOpen size={20} /></span>
              <strong>처음 시작하기</strong>
              <small>폴더 선택, 분석 방식, 기준 설정</small>
              <ArrowRight size={17} />
            </button>
            <button className="guide-menu-item" onClick={() => onChange({ kind: "review", step: 0 })} disabled={!hasReview}>
              <span><MagnifyingGlass size={20} /></span>
              <strong>결과 검토하기</strong>
              <small>{hasReview ? "그룹 이동, 사진 선택, 휴지통 이동" : "분석 결과가 있을 때 화면에서 안내합니다"}</small>
              <ArrowRight size={17} />
            </button>
            <button className="guide-menu-item" onClick={() => onChange({ kind: "shortcuts", step: 0 })}>
              <span><Keyboard size={20} /></span>
              <strong>단축키 보기</strong>
              <small>탐색과 보관, 후보 선택을 빠르게 실행</small>
              <ArrowRight size={17} />
            </button>
          </div>
        </div>
      ) : guide.kind === "shortcuts" ? (
        <div className="guide-dialog guide-shortcuts" ref={panelRef}>
          <button className="guide-close" aria-label="단축키 안내 닫기" onClick={onClose}><X size={18} /></button>
          <div className="guide-icon"><Keyboard size={25} /></div>
          <h2 id="guide-title" ref={headingRef} tabIndex={-1}>키보드로 빠르게 검토하세요</h2>
          <p>사진이나 입력 칸을 편집 중일 때는 단축키가 실행되지 않습니다.</p>
          <div className="shortcut-groups">
            <section>
              <h3>그룹과 사진 선택</h3>
              <ShortcutRow keys={["←", "→"]} label="이전 또는 다음 그룹" />
              <ShortcutRow keys={["1-9"]} label="해당 번호 사진만 보관" />
            </section>
            <section>
              <h3>선택한 사진</h3>
              <ShortcutRow keys={["⇧", "S"]} label="보관" />
              <ShortcutRow keys={["⇧", "D"]} label="삭제 후보로 표시" />
            </section>
            <section>
              <h3>현재 그룹 전체</h3>
              <ShortcutRow keys={["⇧", "N"]} label="전부 보관" />
              <ShortcutRow keys={["⇧", "A"]} label="전부 후보로 표시" />
            </section>
          </div>
          <div className="guide-key-note"><WarningCircle size={17} weight="fill" />Command, Control, Option 조합은 브라우저 명령을 위해 사용하지 않습니다.</div>
          <div className="guide-footer">
            <button className="button button-secondary" onClick={() => onChange({ kind: "menu", step: 0 })}>사용법 목록</button>
            <button className="button button-primary" onClick={onClose}><Check size={16} weight="bold" />확인</button>
          </div>
        </div>
      ) : currentStep ? (
        <div className="guide-popover" ref={panelRef} style={popoverStyle}>
          <div className="guide-progress">
            <span>{guide.step + 1} / {steps.length}</span>
            <button onClick={onClose}>건너뛰기</button>
          </div>
          <h2 id="guide-title" ref={headingRef} tabIndex={-1}>{currentStep.title}</h2>
          <p>{currentStep.copy}</p>
          <div className="guide-footer">
            <button className="button button-secondary" onClick={previousStep} disabled={guide.step === 0}><ArrowLeft size={16} />이전</button>
            <button className="button button-primary" onClick={nextStep}>
              {guide.kind === "review" && guide.step === steps.length - 1 ? "단축키 보기" : guide.step === steps.length - 1 ? "완료" : "다음"}
              {guide.step === steps.length - 1 && guide.kind !== "review" ? <Check size={16} weight="bold" /> : <ArrowRight size={16} />}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
