import { useEffect, useRef, useState, type CSSProperties } from "react";
import { LinearIcon } from "./LinearIcon";

type ToastNotice = {
  id: string;
  message: string;
  action?: { label: string; run: () => void };
};
const toastEvent = "taskboard:toast";
const dismissEvent = "taskboard:toast-dismiss";
let sequence = 0;

export function showToast(message: string, action?: ToastNotice["action"]) {
  const notice: ToastNotice = { id: action ? "undo" : `notice-${++sequence}`, message, action };
  window.dispatchEvent(new CustomEvent(toastEvent, { detail: notice }));
}

export function dismissUndoToast() {
  window.dispatchEvent(new CustomEvent(dismissEvent, { detail: "undo" }));
}

function ToastCard({ notice, paused, behind, dismiss }: {
  notice: ToastNotice;
  paused: boolean;
  behind: boolean;
  dismiss: () => void;
}) {
  const remaining = useRef(notice.action ? 5500 : 3400);
  const start = useRef(0);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    remaining.current = notice.action ? 5500 : 3400;
  }, [notice]);
  useEffect(() => {
    if (paused) return;
    start.current = performance.now();
    const timer = window.setTimeout(() => dismissRef.current(), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current -= performance.now() - start.current;
    };
  }, [notice, paused]);
  return <div
    className={`toast-pill${behind ? " is-behind" : ""}`}
    style={{ transform: `translate(${drag.x}px, ${drag.y}px)` }}
    onPointerDown={(event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (pointer.current) setDrag({ x: event.clientX - pointer.current.x, y: event.clientY - pointer.current.y });
    }}
    onPointerUp={(event) => {
      if (!pointer.current) return;
      const distance = Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y);
      pointer.current = null;
      setDrag({ x: 0, y: 0 });
      if (distance > 48) dismiss();
    }}
    onPointerCancel={() => { pointer.current = null; setDrag({ x: 0, y: 0 }); }}
  >
    <span className="toast-mark" aria-hidden="true"><LinearIcon name="check" /></span>
    <span className="toast-message">{notice.message}</span>
    {notice.action && <button type="button" tabIndex={behind ? -1 : 0} onClick={() => { dismiss(); notice.action?.run(); }}>{notice.action.label}</button>}
  </div>;
}

export function Toasts() {
  const root = useRef<HTMLDivElement>(null);
  const [notices, setNotices] = useState<ToastNotice[]>([]);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [holding, setHolding] = useState(false);
  const expanded = hovered || focused || holding;
  useEffect(() => {
    setFocused(Boolean(root.current?.contains(document.activeElement)));
    if (!notices.length) {
      setHovered(false);
      setHolding(false);
    }
  }, [notices]);
  useEffect(() => {
    const add = (event: Event) => {
      const notice = (event as CustomEvent<ToastNotice>).detail;
      setNotices((current) => [notice, ...current.filter((item) => item.id !== notice.id)]);
    };
    const remove = (event: Event) => setNotices((current) => current.filter((item) => item.id !== (event as CustomEvent<string>).detail));
    window.addEventListener(toastEvent, add);
    window.addEventListener(dismissEvent, remove);
    return () => { window.removeEventListener(toastEvent, add); window.removeEventListener(dismissEvent, remove); };
  }, []);
  return <div ref={root} className={`toast-stack${expanded ? " is-expanded" : ""}`} role="status" aria-live="polite"
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onPointerDown={() => setHolding(true)} onPointerUp={() => setHolding(false)} onPointerCancel={() => setHolding(false)}
    onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    style={{ height: notices.length ? 36 + (expanded ? (notices.length - 1) * 44 : Math.min(notices.length - 1, 2) * 8) : 0 }}>
    {notices.map((notice, index) => <div key={notice.id} className="toast-slot"
      style={{ "--toast-offset": `${expanded ? index * 44 : Math.min(index, 2) * 8}px`, "--toast-scale": expanded ? 1 : 1 - Math.min(index, 2) * 0.04, opacity: expanded || index < 3 ? 1 : 0, zIndex: notices.length - index } as CSSProperties}
      aria-hidden={!expanded && index > 0 ? true : undefined}>
      <ToastCard notice={notice} paused={expanded} behind={!expanded && index > 0} dismiss={() => setNotices((current) => current.filter((item) => item.id !== notice.id))} />
    </div>)}
  </div>;
}
