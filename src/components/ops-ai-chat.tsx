"use client";

import { FormEvent, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronLeft, ChevronRight, GripVertical, X, Mic, Volume2, Square } from "lucide-react";
import {
  ASSISTANT_POSITION_KEY, DEFAULT_ASSISTANT_POSITION, assistantPoint, assistantPanel,
  clampAssistantPoint, dockAssistant, readAssistantPreference,
  type AssistantPoint, type AssistantPreference, type AssistantViewport
} from "@/lib/ops-pulse/assistant-position";

import { assistantLanguage, matchingAssistantVoice, textMatchesLanguage, type AssistantLanguage } from "@/lib/ops-pulse/assistant-language";

type Message = { role: "user" | "assistant"; text: string; sources?: { label: string; href: string }[]; checkedAt?: string; language?: AssistantLanguage };

export function OpsAiChat() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState<number | null>(null);
  const [voiceError, setVoiceError] = useState("");
  const [language, setLanguage] = useState<AssistantLanguage>("en-IN");
  const [preparingSpeech, setPreparingSpeech] = useState(false);
  const speechRequest = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef<string | null>(null);
  const speechCache = useRef(new Map<string, { text: string; audio: string; mimeType: string }>());
  const requestRef = useRef<AbortController | null>(null);
  const messageList = useRef<HTMLDivElement>(null);
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
      recognition.current?.abort?.();
      stopSpeech();
      requestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (open) input.current?.focus();
    else if (wasOpen.current) launcher.current?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => { messageList.current?.scrollTo?.({ top: messageList.current.scrollHeight, behavior: "smooth" }); }, [messages, loading]);

  function stopSpeech() {
    speechRequest.current?.abort(); speechRequest.current = null;
    window.speechSynthesis?.cancel();
    if (audioRef.current) { audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.pause(); audioRef.current.src = ""; audioRef.current = null; }
    if (audioUrl.current) { URL.revokeObjectURL(audioUrl.current); audioUrl.current = null; }
    setSpeaking(null); setPreparingSpeech(false);
  }

  async function speak(text: string, index: number) {
    const wasSpeaking = speaking === index;
    stopSpeech();
    if (wasSpeaking) return;
    setVoiceError(""); setSpeaking(index);
    // Never let speechSynthesis choose a default English voice for another language.
    const voice = matchingAssistantVoice(window.speechSynthesis?.getVoices() || [], language);
    if (voice && textMatchesLanguage(text, language)) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = language; utterance.voice = voice; utterance.rate = .95;
      utterance.onend = () => setSpeaking(null);
      utterance.onerror = () => { setSpeaking(null); setVoiceError("Audio could not play. Tap Listen to retry."); };
      window.speechSynthesis.speak(utterance);
      return;
    }
    const controller = new AbortController(); speechRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 75000);
    setPreparingSpeech(true);
    try {
      const key = language + ":" + text;
      let result = speechCache.current.get(key);
      if (!result) {
        const response = await fetch("/api/ops-pulse/ai-speech", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, language }) });
        const payload = await response.json();
        if (!response.ok || !payload.audio) throw Error(payload.error || "Audio is unavailable. Please retry.");
        result = payload;
        if (speechCache.current.size >= 5) speechCache.current.delete(speechCache.current.keys().next().value!);
        speechCache.current.set(key, result!);
      }
      if (speechRequest.current !== controller || controller.signal.aborted || !result) return;
      setMessages(current => current.map((message, i) => i === index ? { ...message, text: result!.text, language } : message));
      const bytes = Uint8Array.from(atob(result.audio), char => char.charCodeAt(0));
      audioUrl.current = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      const audio = new Audio(audioUrl.current); audioRef.current = audio;
      audio.onended = () => stopSpeech();
      audio.onerror = () => { stopSpeech(); setVoiceError("Audio could not play. Tap Listen to retry."); };
      setPreparingSpeech(false);
      await audio.play();
    } catch (error) {
      if (speechRequest.current !== controller) return;
      stopSpeech();
      setVoiceError(controller.signal.aborted ? "Audio took too long. Tap Listen to retry." : error instanceof Error ? error.message : "Audio is unavailable. Please retry.");
    } finally { window.clearTimeout(timeout); }
  }

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
    stopSpeech();
    setOpen(false);
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || loading) return;
    setMessages((current) => [...current, { role: "user", text }]);
    setQuestion("");
    setLoading(true);
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 110000);
    const result = await fetch("/api/ops-pulse/ai-chat", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: text, language,
        context: window.location.pathname,
        history: messages.slice(-6)
      })
    }).then((response) => response.json()).catch(() => ({ error: "Unable to reach the OpsPulse assistant." }));
    window.clearTimeout(timeout);
    if (requestRef.current !== controller) return;
    setMessages((current) => [...current, { role: "assistant", text: result.answer || result.error || "No answer returned.", sources: result.sources, checkedAt: result.checkedAt, language: result.language }]);
    if (result.languageError) setVoiceError(result.languageError);
    setLoading(false);
  }

  function dictate() {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { setMessages((current) => [...current, { role: "assistant", text: "Voice typing is not supported in this browser. You can type the question." }]); return; }
    if (listening && recognition.current) { recognition.current.stop(); return; }
    const instance = new SpeechRecognition();
    stopSpeech(); setVoiceError("");
    instance.lang = language;
    instance.interimResults = true;
    instance.continuous = false;
    instance.onresult = (event: any) => setQuestion(Array.from(event.results).map((result: any) => result[0].transcript).join(""));
    instance.onstart = () => setListening(true);
    instance.onend = () => setListening(false);
    instance.onerror = (event: any) => { setListening(false); setVoiceError(event.error === "not-allowed" ? "Microphone permission is blocked. Allow it in browser settings or type your question." : "Could not hear the question. Try again or type it."); };
    recognition.current = instance;
    try { instance.start(); } catch { setListening(false); setVoiceError("Microphone could not start. Please type your question."); }
  }

  return <div className={`ops-ai ${open ? "open" : ""}`} onKeyDown={event => { if (event.key === "Escape" && open) { event.preventDefault(); closeChat(); } }}>
    {open ? <section aria-label="Ask OpsPulse" className="ops-ai-panel" role="dialog" style={viewport ? assistantPanel(preference, viewport) : undefined}><header><div><span>OPSPULSE ASSISTANT</span><strong>Ask OpsPulse</strong></div><button type="button" onClick={closeChat} aria-label="Close Ask OpsPulse"><X size={20} /></button></header>
      <div ref={messageList} className="ops-ai-messages" role="log" aria-live="polite">{!messages.length ? <div className="ops-ai-welcome"><b>Ask about your permitted operations.</b><span>Try “Who is on shift today?”, “Which audits need action?” or “Explain this month’s costs.” Answers use your selected workspace and permitted data.</span></div> : null}{messages.map((message, index) => <div key={index} className={message.role}><span>{message.text}</span>{message.role === "assistant" && <>
        <div className="ops-ai-answer-actions"><button type="button" onClick={() => speak(message.text, index)} aria-label={speaking === index ? "Stop reading" : "Read answer aloud"}>{speaking === index ? <Square size={14}/> : <Volume2 size={14}/>} {speaking === index ? preparingSpeech ? "Preparing… · Stop" : "Stop" : "Listen"}</button>{message.sources?.map(source => <a key={source.href + source.label} href={source.href}>{source.label} ↗</a>)}</div>
        {message.checkedAt && <small>Checked {new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(message.checkedAt))} IST</small>}
      </>}</div>)}{loading ? <div className="assistant loading">Checking live data…</div> : null}</div>
      <div className="ops-ai-voice"><label>Language <select aria-label="Answer and voice language" value={language} onChange={e => { recognition.current?.stop(); stopSpeech(); setVoiceError(""); setLanguage(assistantLanguage(e.target.value)); }}><option value="en-IN">English</option><option value="hi-IN">Hindi</option><option value="ml-IN">Malayalam</option><option value="te-IN">Telugu</option><option value="ta-IN">Tamil</option></select></label><span>For answers, dictation and playback</span></div>
      {voiceError && <p className="ops-ai-voice-error" role="status">{voiceError}</p>}
      <form onSubmit={ask}><button className={listening ? "listening" : ""} type="button" onClick={dictate} aria-label={listening ? "Stop voice typing" : "Voice typing"} aria-pressed={listening}>{listening ? <Square size={18}/> : <Mic size={18}/>}</button><input ref={input} aria-label="Question for OpsPulse" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={listening ? "Listening…" : "Ask about your operations"}/><button aria-label="Send question" type="submit" disabled={!question.trim() || loading}>↑</button></form>
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
