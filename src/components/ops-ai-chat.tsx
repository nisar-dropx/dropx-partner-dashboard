"use client";

import { FormEvent, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronLeft, ChevronRight, GripVertical, X } from "lucide-react";
import {
  ASSISTANT_POSITION_KEY, DEFAULT_ASSISTANT_POSITION, assistantPoint, assistantPanel,
  clampAssistantPoint, dockAssistant, readAssistantPreference,
  type AssistantPoint, type AssistantPreference, type AssistantViewport
} from "@/lib/ops-pulse/assistant-position";

type Message = { role: "user" | "assistant"; text: string };

export function OpsAiChat() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const recognition = useRef<any>(null);
  const [preference, setPreference] = useState(DEFAULT_ASSISTANT_POSITION);
  const [viewport, setViewport] = useState<AssistantViewport | null>(null);
  const [dragPoint, setDragPoint] = useState<AssistantPoint | null>(null);
  const drag = useRef<{ pointerId: number; start: AssistantPoint; origin: AssistantPoint; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);
  const point = viewport ? dragPoint ?? assistantPoint(preference, viewport) : null;

  useEffect(() => {
    try { setPreference(readAssistantPreference(window.localStorage.getItem(ASSISTANT_POSITION_KEY))); } catch { /* Storage can be blocked. */ }
    const updateViewport = () => {
      const visual = window.visualViewport;
      setViewport({ width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight, left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0 });
      drag.current = null;
      setDragPoint(null);
    };
    updateViewport();
    window.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
      recognition.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (open) input.current?.focus();
    else if (wasOpen.current) launcher.current?.focus();
    wasOpen.current = open;
  }, [open]);

  function remember(next: AssistantPreference) {
    setPreference(next);
    try { window.localStorage.setItem(ASSISTANT_POSITION_KEY, JSON.stringify(next)); } catch { /* Still movable for this visit. */ }
  }

  function cancelDrag() {
    drag.current = null;
    setDragPoint(null);
  }

  function beginDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!viewport || !point || event.button !== 0 || !event.isPrimary) return;
    suppressClick.current = false;
    drag.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: point, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || !viewport || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.start.x, dy = event.clientY - active.start.y;
    if (!active.moved && Math.hypot(dx, dy) < 6) return;
    active.moved = true;
    suppressClick.current = true;
    setDragPoint(clampAssistantPoint({ x: active.origin.x + dx, y: active.origin.y + dy }, viewport, preference.collapsed));
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || !viewport || active.pointerId !== event.pointerId) return;
    if (active.moved) remember(dockAssistant({
      x: active.origin.x + event.clientX - active.start.x,
      y: active.origin.y + event.clientY - active.start.y
    }, viewport, preference.collapsed));
    cancelDrag();
  }

  function moveWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (!viewport || !point) return;
    if (event.key === "Escape") { cancelDrag(); return; }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") remember({ ...DEFAULT_ASSISTANT_POSITION, collapsed: preference.collapsed });
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") remember({ ...preference, side: event.key === "ArrowLeft" ? "left" : "right" });
    else remember(dockAssistant({ x: point.x, y: point.y + (event.key === "ArrowUp" ? -32 : 32) }, viewport, preference.collapsed));
  }

  function closeChat() {
    recognition.current?.stop();
    setOpen(false);
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || loading) return;
    setMessages((current) => [...current, { role: "user", text }]);
    setQuestion("");
    setLoading(true);
    const result = await fetch("/api/ops-pulse/ai-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: text,
        context: window.location.pathname,
        history: messages.slice(-6)
      })
    }).then((response) => response.json()).catch(() => ({ error: "Unable to reach the OpsPulse assistant." }));
    setMessages((current) => [...current, { role: "assistant", text: result.answer || result.error || "No answer returned." }]);
    setLoading(false);
  }

  function dictate() {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { setMessages((current) => [...current, { role: "assistant", text: "Voice typing is not supported in this browser. You can type the question." }]); return; }
    if (listening && recognition.current) { recognition.current.stop(); return; }
    const instance = new SpeechRecognition();
    instance.lang = "en-IN";
    instance.interimResults = true;
    instance.continuous = false;
    instance.onresult = (event: any) => setQuestion(Array.from(event.results).map((result: any) => result[0].transcript).join(""));
    instance.onstart = () => setListening(true);
    instance.onend = () => setListening(false);
    instance.onerror = () => setListening(false);
    recognition.current = instance;
    instance.start();
  }

  return <div className={`ops-ai ${open ? "open" : ""}`} onKeyDown={event => { if (event.key === "Escape" && open) { event.preventDefault(); closeChat(); } }}>
    {open ? <section aria-label="Ask OpsPulse" className="ops-ai-panel" role="dialog" style={viewport ? assistantPanel(preference, viewport) : undefined}><header><div><span>OPSPULSE ASSISTANT</span><strong>Ask OpsPulse</strong></div><button type="button" onClick={closeChat} aria-label="Close Ask OpsPulse"><X size={20} /></button></header>
      <div className="ops-ai-messages" role="log" aria-live="polite">{!messages.length ? <div className="ops-ai-welcome"><b>Ask about your permitted operations.</b><span>Try “What is GDRD SPR?”, “How many active DAs are in my stations?” or “Which station is above CPS target?”</span></div> : null}{messages.map((message, index) => <div key={index} className={message.role}>{message.text}</div>)}{loading ? <div className="assistant loading">Checking live data…</div> : null}</div>
      <form onSubmit={ask}><button className={listening ? "listening" : ""} type="button" onClick={dictate} aria-label="Voice typing">◉</button><input ref={input} aria-label="Question for OpsPulse" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={listening ? "Listening…" : "Ask about your operations"}/><button aria-label="Send question" type="submit" disabled={!question.trim() || loading}>↑</button></form>
    </section> : null}
    <div className={`ops-ai-dock${preference.collapsed ? " is-collapsed" : ""}${dragPoint ? " is-dragging" : ""}`} hidden={open} style={point ? { left: point.x, top: point.y } : undefined}>
      <button ref={launcher} className="ops-ai-launcher" type="button" aria-label="Ask OpsPulse" aria-haspopup="dialog" aria-describedby="ops-assistant-move-help" title="Ask OpsPulse · Drag to move" onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onKeyDown={moveWithKeyboard} onClick={event => {
        if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; }
        setOpen(true);
      }}>
        <GripVertical className="ops-ai-grip" size={12} aria-hidden="true" />
        <img src="/opspulse/mark.svg?v=2" width={22} height={22} alt="" draggable={false} />
        {!preference.collapsed ? <span>Ask OpsPulse</span> : null}
      </button>
      <button className="ops-ai-minimize" type="button" aria-label={preference.collapsed ? "Show assistant label" : "Minimize assistant"} title={preference.collapsed ? "Show label" : "Minimize"} onClick={() => remember({ ...preference, collapsed: !preference.collapsed })}>{preference.collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}</button>
    </div>
    <span id="ops-assistant-move-help" className="ops-ai-sr-only">Drag to either edge to move. Arrow keys move the control; Home resets its position.</span>
  </div>;
}
