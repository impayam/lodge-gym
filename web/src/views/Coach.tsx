// Coach chat (SPEC-v8 §6.07 shell, SPEC-v9 M12): full-screen chat with saved conversations. Answers stream in as the
// model writes them; between tool calls the model's short progress notes show as the typing line; every tool result is
// drawn as a data card whose numbers the app calculated. Past chats stay readable offline; sending needs a connection.
// Ask Coach from the session screen (Payam, 2026-10-16) shows the same chat in a sheet over the session (`inSession`):
// one chat per session, each message carrying the session and the exercise and set on screen.

import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { errorText, NetworkError } from "../api";
import {
  addDraft,
  archiveThread,
  attachFile,
  attachmentSrc,
  attachProgressPhoto,
  deleteThread,
  loadThread,
  loadThreads,
  MAX_PHOTOS,
  questionText,
  retryAnswer,
  sendMessage,
  takePendingAsk,
  type AskAbout,
  type Attachment,
  type RotationRef,
  type SessionRef,
  type CoachEvent,
  type CoachMessage,
  type CoachThread,
  type CoachThreadData,
  type StoredBlock,
} from "../coach";
import { CoachCard, toolLabel } from "../components/CoachCards";
import { IconBack, IconCamera, IconPlus, IconProgram, IconSend, IconSpark } from "../components/PulseIcons";
import { Sheet } from "../components/Sheet";
import { Empty, LoadError, Loading } from "../components/States";
import { costText, dayMonth, instantShort, plural } from "../format";
import { trainingSince } from "../model";
import { addPhoto, flash, goBack, loadAllHistory, loadPhotos, photoSrc, syncNow, today, useStore } from "../store";
import { ulid } from "../../../worker/lib/ulid";
import { statusMismatches, type VolumeResult } from "../../../worker/lib/coach/statusCheck";
import type { Pose } from "../../../worker/lib/types";

/** Suggested questions (decision 2, approved 2026-10-14). */
const SUGGESTIONS = ["این هفته چطور بودم؟", "برنامه‌ی سینه‌ام را بهتر کن", "چرا پرس سینه‌ام ثابت مانده؟", "این عکس را تحلیل کن"];

/** What the coach can read (the "What it knows" sheet), in plain words. */
const KNOWS = [
  "Your sessions: every done set with weight, reps or seconds and RIR, and the session you are training now.",
  "The estimated 1RM history of any exercise, the same Epley numbers as Reports.",
  "Your weekly sets per muscle group against your program's targets, with the same under / on / over as Reports.",
  "Planned versus done sessions, counted like the training overview.",
  "Your records, by the app's rule.",
  "Your active program, its days and its rules.",
  "The exercise library, to pick exercises for a program.",
  "Your body weight entries.",
  "The list of your progress photos (it sees a photo only when you attach it).",
  "Recovery: your last heavy compound lift per muscle group and how many hours ago it was.",
];

const isPersian = (s: string) => /[؀-ۿ]/.test(s);
/** Class, direction and language of a text in either language (Persian right to left, as the app shows it). */
const textProps = (s: string, cls = "") =>
  isPersian(s) ? { class: `${cls} fa`.trim(), dir: "rtl" as const, lang: "fa" } : { class: cls || undefined, dir: "auto" as const };

type Mode = "chat" | "list" | "archived";

/** Photos attached on this phone, shown from the local copy until the chat reloads from the server. */
const localPhotos = new Map<string, string>();

/** An answer being streamed: text and progress notes by block, the tools called, the cards drawn so far. */
interface Live {
  questionId: string;
  blocks: Map<number, { kind: "text" | "progress"; text: string }>;
  tool: string | null;
  cards: Extract<CoachEvent, { type: "card" }>[];
  error: { code: string; message: string } | null;
}

/** One question and everything that answered it. */
interface Turn {
  question: CoachMessage;
  replies: CoachMessage[];
}

function turnsOf(messages: CoachMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    const isQuestion = m.role === "user" && m.content.some((b) => b.type === "image" || (b.type === "text" && !b.text.startsWith("CONTEXT (written by the app")));
    if (isQuestion) turns.push({ question: m, replies: [] });
    else turns.at(-1)?.replies.push(m);
  }
  return turns;
}

/** A turn failed when its last row is a failed call, or no answer was saved after it. */
function failure(t: Turn): string | null {
  const last = t.replies.filter((r) => r.role === "assistant").at(-1);
  if (last?.error) return last.error.slice(last.error.indexOf(":") + 1).trim() || last.error;
  const end = t.replies.at(-1);
  if (!end || end.role === "user") return "The answer did not finish.";
  return null;
}

/** The chat of each session asked from the session screen, so the sheet opens it again. */
const sessionChats = new Map<string, string>();

export function Coach({ inSession }: { inSession?: { session: () => SessionRef } } = {}) {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const online = useStore((s) => s.sync.online);
  const [mode, setMode] = useState<Mode>("chat");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [data, setData] = useState<CoachThreadData | null>(null);
  const [offline, setOffline] = useState(false);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<(Attachment & { uploading?: boolean })[]>([]);
  const [knows, setKnows] = useState(false);
  const [picker, setPicker] = useState(false);
  /** What a question from another screen is about (a due exercise, a program for his goal), until it is sent. */
  const [rotation, setRotation] = useState<AskAbout | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const sessionId = inSession?.session().id ?? null;
  const draftThread = useRef<string>((sessionId && sessionChats.get(sessionId)) || ulid());
  // The chat on screen. A load or an answer that finishes after Payam has moved to another chat leaves the screen alone.
  const shown = useRef<string>(draftThread.current);
  const isShown = (id: string) => shown.current === id;
  // Loads of the chat on screen can overlap (the reload after an answer, and Payam reopening the chat, say offline):
  // the server's copy is the newest (of two, the later load's); the copy saved on the phone shows only from the latest
  // load and only if no server copy came in since that load started; the latest load says whether it is the offline copy.
  const loads = useRef(0);
  const served = useRef({ load: 0, started: 0 });
  const took = (id: string, load: number, r: { data: CoachThreadData; offline: boolean }) => {
    if (!isShown(id)) return;
    const take = r.offline ? load === loads.current && served.current.started < load : load > served.current.load;
    if (take) {
      setData(r.data);
      setLoadFailure(null);
      if (!r.offline) served.current = { load, started: loads.current };
    }
    if (load === loads.current) setOffline(r.offline);
  };

  useEffect(() => {
    void loadAllHistory();
    // In the session: this session's chat again, when there is one.
    if (sessionId && sessionChats.has(sessionId)) void open(sessionChats.get(sessionId)!);
    // A due line's Ask Coach (Phase B): its question in the new chat the Coach opens with, sent at once; offline it
    // waits in the composer.
    const ask = inSession ? null : takePendingAsk();
    if (ask) {
      if (canSend) void send(ask.text, ask.about);
      else {
        setText(ask.text);
        setRotation(ask.about);
      }
    }
  }, []);
  // The newest message stays in view while an answer streams in, and when a chat opens (in the session: in the sheet).
  useEffect(() => {
    if (mode !== "chat") return;
    const sheet = inSession ? root.current?.closest<HTMLElement>(".sheet") : null;
    if (sheet) sheet.scrollTop = sheet.scrollHeight;
    else if (!inSession) window.scrollTo(0, document.documentElement.scrollHeight);
  }, [data, live, mode]);
  const since = trainingSince(boot);
  const done = Object.values(sessions).filter((s) => s.status === "done" && (!since || s.local_date >= since)).length;

  const open = async (id: string) => {
    if (!isShown(id)) setLive(null);
    shown.current = id;
    setThreadId(id);
    setMode("chat");
    setLoadFailure(null);
    const load = ++loads.current;
    try {
      took(id, load, await loadThread(id));
    } catch (e) {
      if (!isShown(id) || load !== loads.current) return;
      setLoadFailure(e);
      // Offline before this chat was saved on the phone: a reload still on its way shows as the offline copy.
      if (e instanceof NetworkError) setOffline(true);
    }
  };
  const newChat = () => {
    draftThread.current = ulid();
    shown.current = draftThread.current;
    setThreadId(null);
    setData(null);
    setLive(null);
    setText("");
    setAttachments([]);
    setMode("chat");
  };
  const currentId = threadId ?? draftThread.current;

  /** Applies one streamed event; when the answer ends, the chat reloads from the server. */
  const onEvent = (questionId: string) => (e: CoachEvent) => {
    setLive((cur) => {
      const l: Live = cur && cur.questionId === questionId ? { ...cur, blocks: new Map(cur.blocks), cards: [...cur.cards] } : { questionId, blocks: new Map(), tool: null, cards: [], error: null };
      if (e.type === "text" || e.type === "progress") {
        const prev = l.blocks.get(e.index);
        l.blocks.set(e.index, { kind: e.type, text: (prev?.text ?? "") + e.text });
      } else if (e.type === "tool") l.tool = e.name;
      else if (e.type === "card") l.cards.push(e);
      else if (e.type === "error") l.error = { code: e.code, message: e.message };
      return l;
    });
  };
  const finish = async (id: string) => {
    if (!isShown(id)) return;
    const load = ++loads.current;
    try {
      took(id, load, await loadThread(id));
    } catch {
      /* the streamed answer stays on screen */
    }
    setLive(null);
  };
  const run = async (questionId: string, call: (on: (e: CoachEvent) => void) => Promise<void>, id: string) => {
    setLive({ questionId, blocks: new Map(), tool: null, cards: [], error: null });
    // Once Payam leaves this chat, the rest of the answer only goes to the server; the chat shows it when reopened.
    let left = false;
    const on = (e: CoachEvent) => {
      left ||= !isShown(id);
      if (!left) onEvent(questionId)(e);
    };
    try {
      await call(on);
    } catch (e) {
      on({ type: "error", code: "network", message: errorText(e) });
    }
    await finish(id);
  };

  const send = async (question = text, about = rotation) => {
    const q = question.trim();
    if ((!q && !attachments.length) || live || attachments.some((a) => a.uploading)) return;
    const id = currentId;
    const message = {
      id: ulid(),
      text: q,
      attachments: attachments.map(({ id: a, width, height }) => ({ id: a, width, height })),
      ...(inSession ? { session: inSession.session() } : {}),
      ...(about ?? {}),
    };
    setRotation(null);
    const optimistic: CoachMessage = {
      id: message.id,
      role: "user",
      content: [...(q ? [{ type: "text" as const, text: q }] : []), ...attachments.map((a) => ({ type: "image" as const, attachment_id: a.id, width: a.width, height: a.height }))],
      created_at: new Date().toISOString(),
      error: null,
      cost_usd: null,
      model: null,
    };
    const now = new Date().toISOString();
    setData((d) => ({ thread: d?.thread ?? { id, title: q, created_at: now, updated_at: now, archived: false }, messages: [...(d?.messages ?? []), optimistic], omitted: d?.omitted ?? 0 }));
    shown.current = id;
    setThreadId(id);
    setText("");
    setAttachments([]);
    if (inSession) {
      sessionChats.set(message.session!.id, id);
      // The coach reads the session as saved: the sets checked just now go first.
      await syncNow().catch(() => undefined);
    }
    await run(message.id, (on) => sendMessage(id, message, on), id);
  };

  const retry = async (t: Turn) => {
    if (!threadId || live) return;
    await run(t.question.id, (on) => retryAnswer(threadId, on), threadId);
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of [...files].slice(0, MAX_PHOTOS - attachments.length)) {
      const tmp = { id: ulid(), width: 1, height: 1, url: URL.createObjectURL(f), uploading: true };
      setAttachments((list) => [...list, tmp]);
      try {
        const a = await attachFile(currentId, f);
        localPhotos.set(a.id, a.url);
        setAttachments((list) => list.map((x) => (x.id === tmp.id ? a : x)));
      } catch (e) {
        setAttachments((list) => list.filter((x) => x.id !== tmp.id));
        flash(`Couldn't attach the photo. ${errorText(e)}`);
      }
    }
  };
  const addProgressPhoto = async (photoId: string) => {
    setPicker(false);
    if (attachments.length >= MAX_PHOTOS) return;
    try {
      const a = await attachProgressPhoto(currentId, photoId);
      localPhotos.set(a.id, a.url);
      setAttachments((list) => [...list, a]);
    } catch (e) {
      flash(`Couldn't attach the photo. ${errorText(e)}`);
    }
  };

  const changeDraft = () => {
    setText("Change this draft: ");
    input.current?.focus();
  };

  const turns = data ? turnsOf(data.messages) : [];
  const canSend = online && !live && !offline;
  const title = mode === "list" ? "Chats" : mode === "archived" ? "Archived" : "Coach";

  const chat = (
    <div class="l-col l-gap-14" data-testid="coach-chat" ref={root}>
      {offline && data ? <p class="caption l-m0" data-testid="coach-offline">Offline: this is the copy saved on your phone.</p> : null}
      {data?.omitted ? (
        <p class="caption l-m0" data-testid="coach-omitted">
          {plural(data.omitted, "older message")} in this chat {data.omitted === 1 ? "is" : "are"} kept but no longer sent to the coach.
        </p>
      ) : null}
      {loadFailure ? <LoadError what="Couldn't load this chat." error={loadFailure} onRetry={() => threadId && void open(threadId)} /> : null}
      {!data && !loadFailure ? (
        <p class="state l-m0" data-testid="coach-empty">
          {inSession
            ? "Ask about this session. The coach sees the day, the exercise and set on your screen, and the sets you have done."
            : "Ask about your training, your program or a photo. Answers about your numbers come with the app's own data."}
        </p>
      ) : null}
      {turns.map((t, i) => {
        const last = i === turns.length - 1;
        const streaming = live && live.questionId === t.question.id ? live : null;
        return (
          <TurnView
            key={t.question.id}
            turn={t}
            live={streaming}
            failed={!streaming && last ? failure(t) : null}
            onRetry={canSend ? () => void retry(t) : null}
            onChange={changeDraft}
          />
        );
      })}
      {/* Full screen the composer stays at the bottom of the screen; in the session sheet it ends the chat. */}
      <div class={inSession ? "l-col l-gap-10" : "coach-dock"} data-testid="coach-dock">
        {!data && !live && !inSession ? (
          <div class="chip-scroll" aria-label="Suggested questions">
            {SUGGESTIONS.map((q) => (
              <button type="button" class="clay press chip fa" dir="rtl" lang="fa" disabled={!canSend} onClick={() => void send(q)}>
                {q}
              </button>
            ))}
          </div>
        ) : null}
        {attachments.length ? (
          <div class="l-grid-4" data-testid="coach-attachments">
            {attachments.map((a) => (
              <div class="photo-thumb" aria-busy={a.uploading ? "true" : undefined}>
                <span class="photo-thumb__frame">
                  <img src={a.url} alt="Attached photo" />
                </span>
                <button type="button" class="clay press btn-sm t-muted" onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div class="composer" aria-disabled={canSend ? undefined : "true"}>
          <button type="button" class="clay press btn-icon t-violet" aria-label="Attach a photo" data-testid="coach-attach" disabled={!canSend || attachments.length >= MAX_PHOTOS} onClick={() => setPicker(true)}>
            <IconCamera size={20} />
          </button>
          <label class="l-grow l-row">
            <span class="l-sr">Message the coach</span>
            <input
              ref={input}
              class={`composer__input${isPersian(text) ? " fa" : ""}`}
              dir="auto"
              data-testid="coach-input"
              placeholder={online ? "Ask about your training" : "Needs connection"}
              value={text}
              disabled={!canSend}
              onInput={(e) => setText((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === "Enter" && void send()}
            />
          </label>
          <button
            type="button"
            class="clay press btn-icon t-orange"
            aria-label="Send"
            data-testid="coach-send"
            disabled={!canSend || (!text.trim() && !attachments.length) || attachments.some((a) => a.uploading)}
            onClick={() => void send()}
          >
            <IconSend size={20} />
          </button>
        </div>
        <input ref={camera} class="l-sr" type="file" accept="image/*" capture="environment" data-testid="coach-camera" onChange={(e) => {
            const el = e.target as HTMLInputElement;
            void addFiles(el.files).then(() => (el.value = ""));
          }}
        />
        <input ref={library} class="l-sr" type="file" accept="image/*" multiple data-testid="coach-library" onChange={(e) => {
            const el = e.target as HTMLInputElement;
            void addFiles(el.files).then(() => (el.value = ""));
          }}
        />
      </div>
    </div>
  );
  const attach = <AttachSheet open={picker} onClose={() => setPicker(false)} onCamera={() => (setPicker(false), camera.current?.click())} onLibrary={() => (setPicker(false), library.current?.click())} onProgress={addProgressPhoto} />;

  if (inSession)
    return (
      <div data-testid="coach" class="l-col">
        {chat}
        {attach}
      </div>
    );

  return (
    <main class="page" data-testid="coach">
      <header class="screen-head">
        <button type="button" class="clay press btn-icon t-muted" aria-label="Back" data-testid="coach-back" onClick={() => (mode === "chat" ? goBack() : setMode(mode === "archived" ? "list" : "chat"))}>
          <IconBack size={20} />
        </button>
        <div class="l-col l-gap-2 l-grow">
          <h1 class="screen-head__title l-m0">{title}</h1>
          {mode === "chat" ? (
            <span class="screen-head__sub">
              Knows your {plural(done, "session")}
              {since ? ` since ${dayMonth(since)}` : ""}
            </span>
          ) : null}
        </div>
        {mode === "chat" ? (
          <>
            <button type="button" class="clay press btn-icon t-violet" aria-label="What the coach knows" data-testid="coach-knows" onClick={() => setKnows(true)}>
              <IconSpark size={20} />
            </button>
            <button type="button" class="clay press btn-icon t-muted" aria-label="Chats" data-testid="coach-chats" onClick={() => setMode("list")}>
              <IconProgram size={20} />
            </button>
          </>
        ) : null}
        <button type="button" class="clay press btn-icon t-pink" aria-label="New chat" data-testid="coach-new" onClick={newChat}>
          <IconPlus size={20} />
        </button>
      </header>

      {mode === "chat" ? (
        chat
      ) : (
        <ThreadList archived={mode === "archived"} onOpen={(id) => void open(id)} onArchived={() => setMode("archived")} current={threadId} onDeletedCurrent={newChat} />
      )}

      <Sheet open={knows} onClose={() => setKnows(false)} title="What the coach knows" testId="coach-knows-sheet">
        <ul class="prose-list l-m0">
          {KNOWS.map((k) => (
            <li>{k}</li>
          ))}
        </ul>
        <p class="caption l-m0">It reads your data only through the app, never changes it, and can only propose a program draft that you add with a tap. The cost of each answer shows under it.</p>
      </Sheet>
      {attach}
    </main>
  );
}

/** Answer text: paragraphs, and "-" lines as a list (the coach writes plain text). */
function AnswerText({ text }: { text: string }) {
  const parts = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <>
      {parts.map((p) => {
        const lines = p.split("\n");
        const bullets = lines.every((l) => /^\s*[-•]\s/.test(l));
        return bullets ? (
          <ul {...textProps(p, "prose-list l-m0")}>
            {lines.map((l) => (
              <li>{l.replace(/^\s*[-•]\s/, "")}</li>
            ))}
          </ul>
        ) : (
          <p {...textProps(p, "l-m0")}>
            {p}
          </p>
        );
      })}
    </>
  );
}

function Typing({ label }: { label: string }) {
  return (
    <div class="typing" role="status" data-testid="coach-typing">
      <span class="typing__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span {...textProps(label)}>{label}</span>
    </div>
  );
}

function TurnView({ turn, live, failed, onRetry, onChange }: { turn: Turn; live: Live | null; failed: string | null; onRetry: (() => void) | null; onChange: () => void }) {
  const q = questionText(turn.question.content);
  const images = turn.question.content.filter((b): b is Extract<StoredBlock, { type: "image" }> => b.type === "image");
  const results = new Map(turn.replies.flatMap((r) => r.content).flatMap((b) => (b.type === "tool_result" ? [[b.tool_use_id, b] as const] : [])));
  const cost = turn.replies.reduce<number | null>((a, r) => (r.cost_usd != null ? (a ?? 0) + r.cost_usd : a), null);
  const answered = turn.replies.some((r) => r.role === "assistant" && !r.error);

  const body: ComponentChildren[] = [];
  for (const r of turn.replies) {
    if (r.role !== "assistant" || r.error) continue;
    for (const b of r.content) {
      if (b.type === "thinking" && b.thinking.trim()) body.push(<p {...textProps(b.thinking, "caption l-m0")}>{b.thinking.trim()}</p>);
      if (b.type === "text" && b.text.trim()) body.push(<AnswerText text={b.text} />);
      if (b.type === "tool_use") {
        const res = results.get(b.id);
        if (!res || res.type !== "tool_result" || res.is_error) continue;
        body.push(<CoachCard name={b.name} input={b.input} result={JSON.parse(res.content)} messageId={r.id} toolUseId={b.id} onChange={onChange} onAdd={addDraft} />);
      }
    }
  }
  if (live) {
    for (const [, blk] of [...live.blocks].sort(([a], [b]) => a - b)) {
      if (blk.kind === "progress" && blk.text.trim()) body.push(<p {...textProps(blk.text, "caption l-m0")}>{blk.text.trim()}</p>);
      if (blk.kind === "text") body.push(<AnswerText text={blk.text} />);
    }
    for (const c of live.cards) if (!c.is_error) body.push(<CoachCard name={c.name} input={c.input} result={c.result} messageId={c.message_id} toolUseId={c.tool_use_id} onChange={onChange} onAdd={addDraft} />);
  }
  // The answer's text against its own get_volume cards: a status the cards do not show gets a note (never hidden).
  const said = turn.replies.filter((r) => r.role === "assistant" && !r.error).flatMap((r) => r.content);
  const volumes = said.flatMap((b) => {
    const res = b.type === "tool_use" && b.name === "get_volume" ? results.get(b.id) : undefined;
    return res && res.type === "tool_result" && !res.is_error ? [JSON.parse(res.content) as VolumeResult] : [];
  });
  const answerText = said.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
  const mismatch = !live && volumes.length > 0 && statusMismatches(answerText, volumes).length > 0;
  const lastProgress = live ? [...live.blocks.values()].filter((b) => b.kind === "progress").at(-1)?.text.trim() : null;
  const writing = live && !live.error && ![...live.blocks.values()].some((b) => b.kind === "text");

  return (
    <section class="l-col l-gap-14" data-testid="coach-turn" data-question={turn.question.id}>
      {q || images.length ? (
        <div data-testid="coach-question" {...textProps(q, "msg-user l-col l-gap-8")}>
          {images.length ? (
            <div class="l-grid-2">
              {images.map((img) => (
                <ChatPhoto id={img.attachment_id} />
              ))}
            </div>
          ) : null}
          {q ? <span>{q}</span> : null}
        </div>
      ) : null}
      {body.length || live ? (
        <div class="msg-coach" data-testid="coach-answer">
          {body}
          {writing ? <Typing label={lastProgress || (live?.tool ? toolLabel(live.tool) : "Thinking")} /> : null}
        </div>
      ) : null}
      {mismatch ? (
        <p class="caption t-orange l-m0" data-testid="coach-status-note">
          The numbers in the card are the app's; the text may be wrong.
        </p>
      ) : null}
      {live?.error || failed ? (
        <div class="l-row l-between l-gap-8" data-testid="coach-failed">
          <span class="caption t-orange">Answer failed — {live?.error?.message ?? failed}</span>
          {onRetry && !live ? (
            <button type="button" class="clay press btn-sm t-pink" data-testid="coach-retry" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {answered && !live && costText(cost) ? (
        <span class="caption num" data-testid="coach-cost">
          {costText(cost)}
        </span>
      ) : null}
    </section>
  );
}

/** A photo in Payam's message, with "Save to progress photos" (chat photos are not in the gallery otherwise). */
function ChatPhoto({ id }: { id: string }) {
  const [pick, setPick] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = async (pose: Pose) => {
    setPick(false);
    try {
      const blob = await (await fetch(attachmentSrc(id), { credentials: "same-origin" })).blob();
      await addPhoto(blob, pose, today(), null);
      setSaved(true);
      flash("Saved to progress photos.");
    } catch (e) {
      flash(`Couldn't save the photo. ${errorText(e)}`);
    }
  };
  return (
    <div class="photo-thumb">
      <span class="photo-thumb__frame">
        <img src={localPhotos.get(id) ?? attachmentSrc(id)} alt="Photo sent to the coach" data-testid="coach-photo" data-src={attachmentSrc(id)} />
      </span>
      {saved ? (
        <span class="caption">Saved</span>
      ) : (
        <button type="button" class="clay press btn-sm t-muted" data-testid="coach-save-photo" onClick={() => setPick(true)}>
          Save to progress photos
        </button>
      )}
      <Sheet open={pick} onClose={() => setPick(false)} title="Save to progress photos" sub="Which pose is it?" testId="coach-pose-sheet">
        <div class="l-grid-2">
          {(["front", "side", "back", "other"] as Pose[]).map((p) => (
            <button type="button" class="clay press btn" onClick={() => void save(p)}>
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

function AttachSheet({ open, onClose, onCamera, onLibrary, onProgress }: { open: boolean; onClose: () => void; onCamera: () => void; onLibrary: () => void; onProgress: (id: string) => void }) {
  const photos = useStore((s) => s.photos);
  useEffect(() => {
    if (open) loadPhotos();
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title="Attach a photo" sub={`Up to ${MAX_PHOTOS} photos per message.`} testId="coach-attach-sheet">
      <div class="l-grid-2">
        <button type="button" class="clay press btn" data-testid="coach-take-photo" onClick={onCamera}>
          Take a photo
        </button>
        <button type="button" class="clay press btn" data-testid="coach-choose-photo" onClick={onLibrary}>
          Choose from library
        </button>
      </div>
      {photos.length ? (
        <div class="l-col l-gap-8">
          <h3 class="section-label l-m0">Progress photos</h3>
          <div class="l-grid-4">
            {photos.slice(0, 24).map((p) => (
              <button type="button" class="photo-thumb press" data-testid="coach-progress-photo" onClick={() => onProgress(p.id)}>
                <span class="photo-thumb__frame">
                  <img src={photoSrc(p, "thumb")} alt={`${p.pose}, ${dayMonth(p.local_date)}`} />
                </span>
                <span class="num">{dayMonth(p.local_date)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

/** The chat list or the Archived list. Only archived chats can be deleted, after a confirm. */
function ThreadList({ archived, onOpen, onArchived, current, onDeletedCurrent }: { archived: boolean; onOpen: (id: string) => void; onArchived: () => void; current: string | null; onDeletedCurrent: () => void }) {
  const tz = useStore((s) => s.boot!.settings.timezone);
  const online = useStore((s) => s.sync.online);
  const [threads, setThreads] = useState<CoachThread[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [round, setRound] = useState(0);
  const [confirm, setConfirm] = useState<CoachThread | null>(null);
  useEffect(() => {
    setFailure(null);
    setThreads(null);
    loadThreads(archived)
      .then((r) => setThreads(r.threads))
      .catch((e) => setFailure(e));
  }, [archived, round]);
  const act = async (f: () => Promise<unknown>, done: string) => {
    try {
      await f();
      flash(done);
      setRound((n) => n + 1);
    } catch (e) {
      flash(errorText(e));
    }
  };
  return (
    <div class="l-col l-gap-12" data-testid={archived ? "coach-archived" : "coach-list"}>
      {failure ? <LoadError what={archived ? "Couldn't load your archived chats." : "Couldn't load your chats."} error={failure} onRetry={() => setRound((n) => n + 1)} /> : null}
      {threads === null && !failure ? <Loading label="Loading your chats" heights={[56, 56]} /> : null}
      {threads && !threads.length ? <Empty testId="coach-list-empty">{archived ? "No archived chats." : "No chats yet. Ask the coach something to start one."}</Empty> : null}
      {threads?.length ? (
        <div class="card card--list">
          {threads.map((t) => (
            <div class="list-row" data-testid="coach-thread">
              <button type="button" class="ex-row__main press" data-testid="coach-thread-open" onClick={() => onOpen(t.id)}>
                <span class="list-row__text">
                  <span {...textProps(t.title, "t-title")}>
                    {t.title}
                  </span>
                  <span class="caption num">{instantShort(t.updated_at, tz)}</span>
                </span>
              </button>
              {archived ? (
                <span class="l-row l-gap-8">
                  <button type="button" class="clay press btn-sm t-muted" data-testid="coach-unarchive" disabled={!online} onClick={() => void act(() => archiveThread(t.id, false), "Chat moved back to Chats.")}>
                    Unarchive
                  </button>
                  <button type="button" class="clay press btn-sm t-danger" data-testid="coach-delete" disabled={!online} onClick={() => setConfirm(t)}>
                    Delete
                  </button>
                </span>
              ) : (
                <button type="button" class="clay press btn-sm t-muted" data-testid="coach-archive" disabled={!online} onClick={() => void act(() => archiveThread(t.id, true), "Chat archived.")}>
                  Archive
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {!archived ? (
        <button type="button" class="clay press btn t-muted" data-testid="coach-open-archived" onClick={onArchived}>
          Archived chats
        </button>
      ) : null}
      <Sheet open={confirm !== null} onClose={() => setConfirm(null)} title="Delete permanently?" role="alertdialog" testId="coach-delete-sheet">
        <p class="l-m0">This chat and its photos will be deleted for good. Your training data and progress photos stay.</p>
        <button
          type="button"
          class="clay press btn t-danger"
          data-testid="coach-delete-confirm"
          onClick={() => {
            const t = confirm!;
            setConfirm(null);
            void act(() => deleteThread(t.id), "Chat deleted.").then(() => t.id === current && onDeletedCurrent());
          }}
        >
          Delete permanently
        </button>
        <button type="button" class="clay press btn t-muted" onClick={() => setConfirm(null)}>
          Cancel
        </button>
      </Sheet>
    </div>
  );
}
