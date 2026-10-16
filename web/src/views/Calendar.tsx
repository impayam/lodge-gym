// Training calendar (SPEC-v10 M13, with Payam's change of 2026-10-15: he enters his shifts, the app suggests the time,
// nothing blocks). The week strip at the top of Home, and the Calendar screen it opens (a pushed screen): the month
// strip, the week grid (04:00–24:00: work shifts, planned / done / missed gym sessions, free times from the shared
// finder) and its List view, Add shift (Copy last week), Plan gym (or a tap on an empty time, or a drag to move), and
// Find times, all on this device's data and written offline through the outbox.

import { useEffect, useRef, useState } from "preact/hooks";
import { DAY_END_MIN, DAY_START_MIN, hm, toMin, weekDates, type FreeSlot, type GymPlan, type SessionBlock, type UpcomingDay, type WorkShift } from "../../../worker/lib/calendar";
import { addDays, localHM } from "../../../worker/lib/time";
import { ulid } from "../../../worker/lib/ulid";
import { Sheet } from "../components/Sheet";
import { ScreenHead } from "../components/ScreenHead";
import { IconBack, IconChevron } from "../components/PulseIcons";
import { Select } from "../components/Select";
import { LoadError, Loading } from "../components/States";
import { dateShort, monthLabel, plural } from "../format";
import { EDGE_ZONE } from "../lib/nav";
import {
  assignDays,
  blockLabel,
  calendarWeek,
  copyLastWeek,
  dayChips,
  dayNumber,
  dragTarget,
  gridPlace,
  minuteAt,
  monthDates,
  newGymPlan,
  nextLine,
  nextPlan,
  sessionBlocks,
  shownPlans,
  slotReason,
  streakNote,
  timeInput,
  timeRange,
  timeValue,
  upcomingFor,
  weekdayName,
  weekLabel,
  weekStartOf,
  type CalendarDay,
  type CalendarSource,
  type DayChip,
  type ShownPlan,
} from "../lib/calendarView";
import { streakWith } from "../../../worker/lib/calendar";
import { dayInfo, daysPerWeek, homeModel } from "../model";
import { calendarSettings, flash, getState, loadCalendarRange, openCalendar, removeGymPlan, removeShift, saveGymPlan, saveShift, today, useStore } from "../store";

/** An hour of the week grid, in CSS pixels: the 44 pt touch row (SPEC-v10 §7). */
const HOUR_PX = 44;
const HOURS = Array.from({ length: (DAY_END_MIN - DAY_START_MIN) / 60 }, (_, i) => DAY_START_MIN + i * 60);
const AXIS = { start: DAY_START_MIN, end: DAY_END_MIN };

const nowMin = (tz: string) => toMin(localHM(tz, new Date().toISOString()));

/** The calendar's data on this device, re-read whenever the store changes. */
function useCalendarSource(): CalendarSource {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const shifts = useStore((s) => s.shifts);
  const plans = useStore((s) => s.gymPlans);
  return {
    shifts: Object.values(shifts),
    plans: Object.values(plans),
    sessions: Object.values(sessions),
    settings: calendarSettings(boot),
    tz: boot.settings.timezone,
    today: today(),
    now: new Date().toISOString(),
  };
}

const dayName = (id: string) => dayInfo(getState().boot!, id).name_en;
const shortDay = (name: string) => name.split(" · ")[0];

/** The program days the next plans train, in order (after the plans already made). */
function upcoming(src: CalendarSource): UpcomingDay[] {
  const boot = getState().boot!;
  return upcomingFor(boot.program.days, homeModel(boot, getState().sessions, src.today).next.dayId, src.plans, src.today);
}

/** A day chip: weekday, date, the shift bar and the training dot. */
function ChipBody({ c }: { c: DayChip }) {
  return (
    <>
      <span>{weekdayName(c.date)}</span>
      <b>{dayNumber(c.date)}</b>
      <span class="cal-shift" data-on={c.shift ? "true" : "false"} />
      <span class="cal-dot" data-kind={c.mark ?? "none"} />
    </>
  );
}

const chipLabel = (c: DayChip) =>
  [dateShort(c.date), c.today ? "today" : "", c.shift ? "work" : "", c.mark === "done" ? "trained" : c.mark === "planned" ? "gym planned" : c.mark === "missed" ? "missed" : ""].filter(Boolean).join(", ");

/**
 * The Home week strip (SPEC-v10 §2): this week's days with a bar for a shift and a dot for training, and the next
 * planned session under it. Tapping it opens the Calendar; with nothing planned, Find times opens its suggestions.
 */
export function CalendarStrip() {
  const boot = useStore((s) => s.boot)!;
  const src = useCalendarSource();
  const start = weekStartOf(src.today, boot.settings.week_start);
  const chips = dayChips(src, weekDates(start));
  const next = nextPlan(src, nowMin(src.tz));
  return (
    <section class="card l-col l-gap-10" data-testid="cal-strip">
      <button
        type="button"
        class="cal-open press"
        aria-label={`Calendar. This week: ${chips.map(chipLabel).join("; ")}. ${nextLine(next, dayName, src.today)}.`}
        data-testid="cal-open"
        onClick={() => openCalendar()}
      >
        <span class="cal-strip" aria-hidden="true">
          {chips.map((c) => (
            <span class="cal-day" data-today={c.today ? "true" : "false"} data-date={c.date} data-mark={c.mark ?? ""} data-shift={c.shift ? "true" : "false"}>
              <ChipBody c={c} />
            </span>
          ))}
        </span>
        <span class={next ? "t-title num" : "caption"} data-testid="cal-next">
          {nextLine(next, dayName, src.today)}
        </span>
      </button>
      {next ? null : (
        <button type="button" class="clay press btn-sm btn--fit t-pink" style={{ alignSelf: "flex-start" }} data-testid="cal-find" onClick={() => openCalendar({ find: true })}>
          Find times
        </button>
      )}
    </section>
  );
}

/** The month strip (SPEC-v10 §1): the month's days with their training dots; the days of the week shown pressed in. */
function MonthStrip({ src, start, onPick }: { src: CalendarSource; start: string; onPick: (date: string) => void }) {
  const dates = monthDates(addDays(start, 3));
  const chips = dayChips(src, dates);
  const week = new Set(weekDates(start));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (el && first) el.scrollLeft = Math.max(0, first.offsetLeft - el.offsetLeft - 4);
  }, [start]);
  return (
    <section aria-label={monthLabel(dates[0])} data-testid="cal-month">
      <div class="cal-month" ref={ref}>
        {chips.map((c) => (
          <button
            type="button"
            class="cal-day press"
            data-today={c.today ? "true" : "false"}
            data-date={c.date}
            data-mark={c.mark ?? ""}
            aria-pressed={week.has(c.date)}
            aria-label={chipLabel(c)}
            onClick={() => onPick(c.date)}
          >
            <ChipBody c={c} />
          </button>
        ))}
      </div>
    </section>
  );
}

type Kind = "work" | "plan" | "done" | "missed" | "free";

interface BlockProps {
  kind: Kind;
  r: { start_min: number; end_min: number };
  label: string;
  title: string;
  sub: string;
  onOpen?: () => void;
  /** Drag to move (plans): the pointer handlers and the offset while dragging. */
  drag?: { onPointerDown: (e: PointerEvent) => void; offset: { dx: number; dy: number } | null };
}

function Block({ kind, r, label, title, sub, onOpen, drag }: BlockProps) {
  const p = gridPlace(r, DAY_START_MIN, DAY_END_MIN, HOUR_PX);
  const style: Record<string, string> = { "--top": `${p.top}px`, "--h": `${p.height}px` };
  if (drag?.offset) style.transform = `translate(${drag.offset.dx}px, ${drag.offset.dy}px)`;
  const inner = (
    <span class="cal-block__label" aria-hidden="true">
      <span>{title}</span>
      <span class="cal-block__time">{sub}</span>
    </span>
  );
  if (!onOpen)
    return (
      <div class={`cal-block cal-block--${kind}`} style={style} role="img" aria-label={label} data-kind={kind} data-start={hm(r.start_min)}>
        {inner}
      </div>
    );
  return (
    <button
      type="button"
      class={`cal-block cal-block--${kind}`}
      style={style}
      aria-label={label}
      data-kind={kind}
      data-start={hm(r.start_min)}
      data-dragging={drag?.offset ? "true" : undefined}
      onPointerDown={drag?.onPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      {inner}
    </button>
  );
}

interface GridActions {
  onWeek: (step: 1 | -1) => void;
  onTap: (date: string, start: number) => void;
  onShift: (x: WorkShift) => void;
  onPlan: (p: ShownPlan) => void;
  onFree: (x: FreeSlot) => void;
  onMove: (p: ShownPlan, to: { date: string; start_min: number; end_min: number }) => void;
}

/**
 * The week grid: 7 day columns over 04:00–24:00 with every block. A tap on an empty time plans gym there (or adds a
 * shift); a plan drags to another time or day; a swipe left or right changes the week.
 */
function WeekGrid({ days, tz, act }: { days: CalendarDay[]; tz: string; act: GridActions }) {
  const ref = useRef<HTMLDivElement>(null);
  // Opens on the current time of day (an hour of context above it).
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = Math.max(0, ((nowMin(tz) - DAY_START_MIN) / 60 - 1) * HOUR_PX);
  }, []);

  // A swipe across the grid changes the week; a tap right after it is not a tap.
  const swipe = useRef<{ id: number; x: number; y: number } | null>(null);
  const swiped = useRef(0);
  const down = (e: PointerEvent) => {
    // The left edge belongs to the swipe back (Pushed); a plan drags.
    if (!e.isPrimary || e.clientX <= EDGE_ZONE || (e.target as Element).closest(".cal-block--plan, .cal-block--missed")) return;
    swipe.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const up = (e: PointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) >= 60 && Math.abs(dx) > 2 * Math.abs(dy)) {
      swiped.current = Date.now();
      act.onWeek(dx < 0 ? 1 : -1);
    }
  };

  // Dragging a plan: 15-minute steps up and down, whole days across.
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const dragging = useRef<{ id: string; pointer: number; x: number; y: number; col: number; moved: boolean; plan: ShownPlan } | null>(null);
  const dragged = useRef(0);
  const startDrag = (p: ShownPlan) => (e: PointerEvent) => {
    if (!e.isPrimary) return;
    const el = e.currentTarget as HTMLElement;
    const col = (el.closest(".cal-col") as HTMLElement | null)?.offsetWidth ?? 0;
    dragging.current = { id: p.id, pointer: e.pointerId, x: e.clientX, y: e.clientY, col, moved: false, plan: p };
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = dragging.current;
      if (!d || ev.pointerId !== d.pointer) return;
      const dx = ev.clientX - d.x;
      const dy = ev.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 8) return;
      d.moved = true;
      setDrag({ id: d.id, dx, dy });
    };
    const end = (ev: PointerEvent) => {
      const d = dragging.current;
      if (!d || ev.pointerId !== d.pointer) return;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      dragging.current = null;
      setDrag(null);
      if (!d.moved || ev.type === "pointercancel") return;
      dragged.current = Date.now();
      const to = dragTarget(d.plan, ev.clientX - d.x, ev.clientY - d.y, d.col, HOUR_PX, AXIS);
      if (to.date !== d.plan.date || to.start_min !== d.plan.start_min) act.onMove(d.plan, to);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };
  const justMoved = () => Date.now() - Math.max(dragged.current, swiped.current) < 400;

  return (
    <section class="card card--calendar" aria-label="Week" data-testid="cal-week">
      <div class="cal-scroll" ref={ref} onPointerDown={down} onPointerUp={up} onPointerCancel={() => (swipe.current = null)}>
        <div class="cal-week">
          <span class="cal-week__head" aria-hidden="true" />
          {days.map((d) => (
            <span class="cal-week__head" data-today={d.today ? "true" : "false"}>
              <span>{weekdayName(d.date)}</span>
              <b>{dayNumber(d.date)}</b>
            </span>
          ))}
          <div aria-hidden="true">
            {HOURS.map((h) => (
              <span class="cal-hour">{hm(h)}</span>
            ))}
          </div>
          {days.map((d) => (
            <div
              class="cal-col"
              role="group"
              aria-label={dateShort(d.date)}
              data-date={d.date}
              data-testid="cal-col"
              onClick={(e) => {
                if (justMoved() || (e.target as Element).closest(".cal-block")) return;
                const top = (e.currentTarget as HTMLElement).getBoundingClientRect().top;
                act.onTap(d.date, minuteAt(e.clientY - top, DAY_START_MIN, HOUR_PX));
              }}
            >
              {HOURS.map(() => (
                <span class="cal-cell" />
              ))}
              {d.shifts.map((x) => (
                <Block kind="work" r={x} label={blockLabel.shift(x)} title="Work" sub={hm(x.start_min)} onOpen={() => !justMoved() && act.onShift(x)} />
              ))}
              {d.free.map((x) => (
                <Block kind="free" r={x} label={`${blockLabel.free(x)}. Plan gym here`} title="Free" sub={hm(x.start_min)} onOpen={() => !justMoved() && act.onFree(x)} />
              ))}
              {d.plans.map((p) => (
                <Block
                  kind={p.state === "missed" ? "missed" : "plan"}
                  r={p}
                  label={`${blockLabel.plan(p, dayName(p.program_day_id))}. Drag to move`}
                  title={p.state === "missed" ? "Missed" : shortDay(dayName(p.program_day_id))}
                  sub={hm(p.start_min)}
                  onOpen={() => !justMoved() && act.onPlan(p)}
                  drag={{ onPointerDown: startDrag(p), offset: drag?.id === p.id ? drag : null }}
                />
              ))}
              {d.sessions.map((b) => (
                <Block kind="done" r={b} label={blockLabel.session(b, dayName(b.program_day_id))} title={shortDay(dayName(b.program_day_id))} sub={hm(b.start_min)} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

type Row =
  | { key: string; kind: "work"; title: string; note: string; r: WorkShift; item: WorkShift }
  | { key: string; kind: "plan" | "missed"; title: string; note: string; r: ShownPlan; item: ShownPlan }
  | { key: string; kind: "done"; title: string; note: string; r: SessionBlock }
  | { key: string; kind: "free"; title: string; note: string; r: FreeSlot; item: FreeSlot };

function dayRows(d: CalendarDay): Row[] {
  const rows: Row[] = [
    ...d.shifts.map((x): Row => ({ key: x.id, kind: "work", title: "Work", note: x.note, r: x, item: x })),
    ...d.plans.map((p): Row => ({ key: p.id, kind: p.state === "missed" ? "missed" : "plan", title: p.state === "missed" ? "Missed" : "Planned", note: dayName(p.program_day_id), r: p, item: p })),
    ...d.sessions.map((b): Row => ({ key: b.id, kind: "done", title: b.status === "active" ? "In progress" : "Done", note: dayName(b.program_day_id), r: b })),
    ...d.free.map((x): Row => ({ key: `free:${x.start_min}`, kind: "free", title: "Free time", note: slotReason(x), r: x, item: x })),
  ];
  return rows.sort((a, b) => a.r.start_min - b.r.start_min);
}

/** A row's mark: the bar of a shift, the dot of a gym session or a free time. */
const Mark = ({ kind }: { kind: Row["kind"] }) => (
  <span class="cal-mark" aria-hidden="true">
    {kind === "work" ? <span class="cal-shift" /> : <span class="cal-dot" data-kind={kind === "plan" ? "planned" : kind} />}
  </span>
);

/** One day's shifts, plans, sessions and free times as rows (the List view and the day sheet); a row opens its item. */
function DayRows({ d, act }: { d: CalendarDay; act: Pick<GridActions, "onShift" | "onPlan" | "onFree"> }) {
  const rows = dayRows(d);
  if (!rows.length) return <p class="caption l-m0" style={{ padding: "10px 0" }}>Nothing on this day.</p>;
  return (
    <ul class="list-plain">
      {rows.map((r) => {
        const body = (
          <>
            <Mark kind={r.kind} />
            <span class="list-row__text">
              <span class="t-title">{r.title}</span>
              {r.note ? <span class="list-row__note">{r.note}</span> : null}
            </span>
            <span class="list-row__value">{timeRange(r.r)}</span>
          </>
        );
        const open = r.kind === "work" ? () => act.onShift(r.item) : r.kind === "plan" || r.kind === "missed" ? () => act.onPlan(r.item) : r.kind === "free" ? () => act.onFree(r.item) : null;
        return (
          <li data-kind={r.kind} data-testid="cal-row">
            {open ? (
              <button type="button" class="list-row press" onClick={open}>
                {body}
              </button>
            ) : (
              <div class="list-row">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The List view (SPEC-v10 §7): the week day by day, the accessible alternative to the grid. */
function WeekList({ days, act }: { days: CalendarDay[]; act: GridActions }) {
  return (
    <section class="card card--list" aria-label="Week as a list" data-testid="cal-list">
      {days.map((d) => (
        <div data-date={d.date}>
          <h3 class="card__title l-m0">
            {dateShort(d.date)}
            {d.today ? " · Today" : ""}
          </h3>
          <DayRows d={d} act={act} />
        </div>
      ))}
    </section>
  );
}

/** The key under the grid: every kind with its mark (never colour alone). */
function Legend({ free }: { free: boolean }) {
  return (
    <div class="chart-legend" aria-hidden="true">
      <span>
        <span class="cal-shift" />
        Work
      </span>
      <span>
        <span class="cal-dot" data-kind="planned" />
        Planned
      </span>
      <span>
        <span class="cal-dot" data-kind="done" />
        Done
      </span>
      <span>
        <span class="cal-dot" data-kind="missed" />
        Missed
      </span>
      {free ? (
        <span>
          <span class="cal-dot" data-kind="free" />
          Free
        </span>
      ) : null}
    </div>
  );
}

/** Day chips for a sheet: the week's seven days, one or several pressed. */
function DayPicker({ week, picked, onToggle, label }: { week: string[]; picked: ReadonlySet<string>; onToggle: (date: string) => void; label: string }) {
  return (
    <fieldset class="form-field">
      <legend class="form-field__label">{label}</legend>
      <div class="cal-strip cal-strip--pick">
        {week.map((date) => (
          <button type="button" class="cal-day press" aria-pressed={picked.has(date)} aria-label={dateShort(date)} data-date={date} onClick={() => onToggle(date)}>
            <span>{weekdayName(date)}</span>
            <b>{dayNumber(date)}</b>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** A time field (native picker, 15-minute steps). */
function TimeField({ id, label, value, onInput }: { id: string; label: string; value: string; onInput: (v: string) => void }) {
  return (
    <div class="form-field">
      <label class="form-field__label" for={id}>
        {label}
      </label>
      <input id={id} class="input num" type="time" step={900} value={value} onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)} />
    </div>
  );
}

/** A delete with its confirm in the same sheet. */
function DeleteButton({ what, onDelete, testid }: { what: string; onDelete: () => void; testid: string }) {
  const [ask, setAsk] = useState(false);
  if (!ask)
    return (
      <button type="button" class="clay press btn t-danger" data-testid={testid} onClick={() => setAsk(true)}>
        Delete {what}
      </button>
    );
  return (
    <div class="callout" role="alert">
      <span class="card__title">Delete this {what}?</span>
      <div class="l-grid-2 l-gap-8">
        <button type="button" class="clay press btn t-danger" data-testid={`${testid}-confirm`} onClick={onDelete}>
          Delete
        </button>
        <button type="button" class="clay press btn t-muted" onClick={() => setAsk(false)}>
          Keep
        </button>
      </div>
    </div>
  );
}

/** Add shift (several days at once) or edit one; Copy last week fills the days of this week that have no shift. */
function ShiftSheet({ week, shift, date, start, src, onClose }: { week: string[]; shift: WorkShift | null; date: string | null; start: number | null; src: CalendarSource; onClose: () => void }) {
  // A new shift starts from the times of the one entered last.
  const last = [...src.shifts].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const [days, setDays] = useState<Set<string>>(() => new Set(shift ? [shift.date] : date ? [date] : []));
  const [from, setFrom] = useState(timeValue(shift?.start_min ?? start ?? last?.start_min ?? toMin("12:00")));
  const [to, setTo] = useState(timeValue(shift?.end_min ?? (start !== null ? Math.min(1440, start + 480) : (last?.end_min ?? toMin("20:00")))));
  const [note, setNote] = useState(shift?.note ?? "");
  const [error, setError] = useState("");
  const now = () => new Date().toISOString();
  const copies = shift ? [] : copyLastWeek(src.shifts, week[0], ulid, now());

  const save = async () => {
    const s = timeInput(from);
    const e = timeInput(to, true);
    if (s === null || e === null || e <= s) return setError("The shift must end after it starts, on the same day (00:00 = midnight).");
    if (!days.size) return setError("Pick at least one day.");
    if (shift) await saveShift({ ...shift, date: [...days][0], start_min: s, end_min: e, note: note.trim(), updated_at: now() });
    else for (const d of [...days].sort()) await saveShift({ id: ulid(), date: d, start_min: s, end_min: e, note: note.trim(), created_at: now(), updated_at: now() });
    flash(shift ? "Shift saved." : days.size === 1 ? "Shift added." : `${days.size} shifts added.`);
    onClose();
  };

  return (
    <div class="l-col l-gap-14">
      <DayPicker
        week={week}
        picked={days}
        label={shift ? "Day" : "Days"}
        onToggle={(d) =>
          setDays((cur) => {
            if (shift) return new Set([d]);
            const n = new Set(cur);
            if (n.has(d)) n.delete(d);
            else n.add(d);
            return n;
          })
        }
      />
      <div class="l-grid-2 l-gap-10">
        <TimeField id="shift-start" label="Start" value={from} onInput={setFrom} />
        <TimeField id="shift-end" label="End" value={to} onInput={setTo} />
      </div>
      <div class="form-field">
        <label class="form-field__label" for="shift-note">
          Note
        </label>
        <input id="shift-note" class="input" maxLength={200} placeholder="Optional" value={note} onInput={(e) => setNote((e.currentTarget as HTMLInputElement).value)} />
      </div>
      {error ? (
        <p class="caption t-orange l-m0" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" class="clay press btn-lg t-pink" data-testid="shift-save" onClick={() => void save()}>
        {shift ? "Save shift" : days.size > 1 ? `Add ${days.size} shifts` : "Add shift"}
      </button>
      {copies.length ? (
        <button
          type="button"
          class="clay press btn t-muted"
          data-testid="shift-copy"
          onClick={() => {
            void (async () => {
              for (const x of copies) await saveShift(x);
              flash(`Copied ${plural(copies.length, "shift")} from last week.`);
              onClose();
            })();
          }}
        >
          Copy last week ({copies.length})
        </button>
      ) : null}
      {shift ? (
        <DeleteButton
          what="shift"
          testid="shift-delete"
          onDelete={() => {
            void removeShift(shift.id).then(() => flash("Shift deleted."));
            onClose();
          }}
        />
      ) : null}
    </div>
  );
}

/** Plan gym (a new plan) or edit one: day, start, program day. Any day and time; a long run of days only gets a note. */
function PlanSheet({ week, plan, date, start, source, src, onClose }: { week: string[]; plan: ShownPlan | null; date: string; start: number; source: GymPlan["source"]; src: CalendarSource; onClose: () => void }) {
  const boot = getState().boot!;
  const days = [...boot.program.days].sort((a, b) => a.position - b.position);
  const next = upcoming(src)[0];
  const [day, setDay] = useState(plan?.date ?? date);
  const [from, setFrom] = useState(timeValue(plan?.start_min ?? start));
  const [programDay, setProgramDay] = useState(plan?.program_day_id ?? next?.id ?? days[0].id);
  const [error, setError] = useState("");
  const minutes = plan && plan.program_day_id === programDay ? plan.end_min - plan.start_min : (days.find((d) => d.id === programDay)?.est_minutes ?? 60);
  const s = timeInput(from);
  const travel = src.settings.travel_buffer_min;
  // The neutral note: the training days around this one (this plan itself left out).
  const training = new Set([...shownPlans(src).filter((p) => p.id !== plan?.id && p.state !== "missed").map((p) => p.date), ...sessionBlocks(src).map((b) => b.date)]);
  const note = streakNote(streakWith(training, day));

  const save = async () => {
    if (s === null) return setError("Pick a start time.");
    const now = new Date().toISOString();
    const p = newGymPlan(plan?.id ?? ulid(), day, s, { id: programDay, minutes }, plan?.source ?? source, plan?.created_at ?? now);
    await saveGymPlan({ ...p, updated_at: now });
    flash(`${plan ? "Moved to" : "Planned"} ${weekdayName(day)} ${hm(p.start_min)} · ${dayName(programDay)}.`);
    onClose();
  };

  return (
    <div class="l-col l-gap-14">
      <DayPicker week={week} picked={new Set([day])} label="Day" onToggle={setDay} />
      <div class="l-grid-2 l-gap-10">
        <TimeField id="plan-start" label="Start" value={from} onInput={setFrom} />
        <div class="form-field">
          <label class="form-field__label" for="plan-day">
            Session
          </label>
          <Select id="plan-day" value={programDay} onChange={(e) => setProgramDay((e.currentTarget as HTMLSelectElement).value)}>
            {days.map((d) => (
              <option value={d.id}>{d.name_en}</option>
            ))}
          </Select>
        </div>
      </div>
      {s !== null ? (
        <p class="caption l-m0 num" data-testid="plan-times">
          {hm(s)}–{hm(Math.min(1440, s + minutes))} · leave {hm(Math.max(0, s - travel))}, back {hm(Math.min(1440, s + minutes + travel))}
          {note ? ` · ${note}` : ""}
        </p>
      ) : null}
      {error ? (
        <p class="caption t-orange l-m0" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" class="clay press btn-lg t-pink" data-testid="plan-save" onClick={() => void save()}>
        {plan ? "Save" : "Plan gym"}
      </button>
      {plan ? (
        <DeleteButton
          what="plan"
          testid="plan-delete"
          onDelete={() => {
            void removeGymPlan(plan.id).then(() => flash("Plan deleted."));
            onClose();
          }}
        />
      ) : null}
    </div>
  );
}

/** A tap on an empty time: plan gym there (the next program day, its usual length) or add a shift there. */
function TapSheet({ date, start, src, onShift, onClose }: { date: string; start: number; src: CalendarSource; onShift: () => void; onClose: () => void }) {
  const next = upcoming(src)[0];
  const plan = async () => {
    if (!next) return;
    const p = newGymPlan(ulid(), date, start, next, "manual", new Date().toISOString());
    await saveGymPlan(p);
    flash(`Planned ${weekdayName(date)} ${hm(p.start_min)} · ${next.name}.`);
    onClose();
  };
  return (
    <div class="l-col l-gap-10">
      {next ? (
        <p class="caption l-m0">
          {next.name} · {next.minutes} min
        </p>
      ) : null}
      <button type="button" class="clay press btn-lg t-pink" data-testid="cal-plan-here" disabled={!next} onClick={() => void plan()}>
        Plan gym here
      </button>
      <button type="button" class="clay press btn t-muted" data-testid="cal-shift-here" onClick={onShift}>
        Add shift here
      </button>
    </div>
  );
}

/**
 * Find times (SPEC-v10 §1, Payam's change): one suggestion a day, best first, the best ones for the week ticked;
 * Add puts one on the calendar, Add all the ticked ones (the next program days in date order).
 */
function FindTimes({ slots, need, perWeek, src, onClose }: { slots: FreeSlot[]; need: number; perWeek: number; src: CalendarSource; onClose: () => void }) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(slots.filter((x) => x.selected).map((x) => x.date)));
  const order = upcoming(src);
  const ticked = slots.filter((x) => checked.has(x.date));
  const assigned = new Map(assignDays(ticked, order).map((a) => [a.slot.date, a.day]));
  const now = () => new Date().toISOString();
  const add = async (list: FreeSlot[]) => {
    const plans = assignDays(list, order).map(({ slot, day }) => newGymPlan(ulid(), slot.date, slot.start_min, day, "finder", now()));
    for (const p of plans) await saveGymPlan(p);
    return plans;
  };
  if (!slots.length)
    return (
      <p class="state l-m0" data-testid="find-none">
        No time fits a session this week. You can still plan one at any time: tap an empty time on the calendar.
      </p>
    );
  return (
    <div class="l-col l-gap-10">
      <p class="caption l-m0" data-testid="find-need">
        {need
          ? `${perWeek - need} of ${perWeek} sessions this week are done or planned; the best ${need === 1 ? "time is" : `${need} times are`} ticked.`
          : "This week's sessions are all done or planned. You can still add more."}
      </p>
      <ul class="list-plain">
        {slots.map((x) => {
          const day = assigned.get(x.date);
          const note = streakNote(x.streak);
          const label = `${dateShort(x.date)} ${timeRange(x)}`;
          return (
            <li class="list-row" data-testid="find-row" data-date={x.date} data-start={hm(x.start_min)}>
              <label class="plan-select">
                <input
                  type="checkbox"
                  aria-label={label}
                  checked={checked.has(x.date)}
                  onChange={() =>
                    setChecked((cur) => {
                      const n = new Set(cur);
                      if (n.has(x.date)) n.delete(x.date);
                      else n.add(x.date);
                      return n;
                    })
                  }
                />
              </label>
              <span class="list-row__text">
                <span class="t-title num">
                  {dateShort(x.date)} · {timeRange(x)}
                </span>
                <span class="list-row__note">{[day?.name, slotReason(x)].filter(Boolean).join(" · ")}</span>
                {note ? <span class="caption">{note}</span> : null}
              </span>
              <button
                type="button"
                class="clay press btn-sm btn--fit t-pink"
                aria-label={`Add ${label}`}
                data-testid="find-add"
                onClick={() => {
                  // On its own it takes the program day it gets among the ticked ones (itself included).
                  const mine = assignDays([x, ...ticked.filter((t) => t.date !== x.date)], order).find((a) => a.slot.date === x.date);
                  if (!mine) return;
                  const p = newGymPlan(ulid(), x.date, x.start_min, mine.day, "finder", now());
                  void saveGymPlan(p).then(() => flash(`Added ${weekdayName(x.date)} ${hm(p.start_min)} · ${mine.day.name}.`));
                }}
              >
                Add
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        class="clay press btn-lg t-pink"
        data-testid="find-add-all"
        disabled={!ticked.length}
        onClick={() =>
          void add(ticked).then((plans) => {
            flash(`Added ${plural(plans.length, "gym session")}.`);
            onClose();
          })
        }
      >
        Add all{ticked.length ? ` (${ticked.length})` : ""}
      </button>
    </div>
  );
}

type SheetState =
  | { kind: "day"; date: string }
  | { kind: "tap"; date: string; start: number }
  | { kind: "shift"; shift: WorkShift | null; date: string | null; start: number | null }
  | { kind: "plan"; plan: ShownPlan | null; date: string; start: number; source: GymPlan["source"] }
  | { kind: "find" };

/** The Calendar screen (SPEC-v10 §1, §2): pushed from the Home week strip. */
export function Calendar() {
  const boot = useStore((s) => s.boot)!;
  const opened = useStore((s) => s.view.calendar);
  const sessions = useStore((s) => s.sessions);
  const load = useStore((s) => s.loads.calendar);
  const src = useCalendarSource();
  const thisWeek = weekStartOf(src.today, boot.settings.week_start);
  const [start, setStart] = useState(opened?.week ?? thisWeek);
  const [free, setFree] = useState(!!opened?.free);
  const [list, setList] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(opened?.find ? { kind: "find" } : null);
  // A closing sheet keeps its title and content while it slides out.
  const lastSheet = useRef<SheetState | null>(sheet);
  if (sheet) lastSheet.current = sheet;
  const shown = sheet ?? lastSheet.current;

  // Weeks older than the bootstrap's 60 days come from the server.
  const old = start < addDays(src.today, -60);
  useEffect(() => {
    if (old) void loadCalendarRange(start, addDays(start, 6));
  }, [start]);

  const perWeek = daysPerWeek(boot);
  const order = upcomingFor(boot.program.days, homeModel(boot, sessions, src.today).next.dayId, src.plans, src.today);
  const finderOpts = { upcoming: order, days_per_week: perWeek, now_min: nowMin(src.tz) };
  const week = calendarWeek(src, start, finderOpts);
  const days = free ? week.days : week.days.map((d) => ({ ...d, free: [] }));
  const dates = weekDates(start);
  const step = (n: 1 | -1) => setStart((s) => addDays(s, 7 * n));
  const label = weekLabel(start, src.today);
  const noShifts = !week.days.some((d) => d.shifts.length);
  const copies = copyLastWeek(src.shifts, start, ulid, new Date().toISOString());
  const firstOpenDay = dates.find((d) => d >= src.today) ?? dates[0];
  const suggestion = (date: string) => week.finder?.slots.find((x) => x.date === date)?.start_min ?? src.settings.earliest_start_min;

  const act: GridActions = {
    onWeek: step,
    onTap: (date, at) => setSheet({ kind: "tap", date, start: at }),
    onShift: (x) => setSheet({ kind: "shift", shift: x, date: null, start: null }),
    onPlan: (p) => setSheet({ kind: "plan", plan: p, date: p.date, start: p.start_min, source: p.source }),
    onFree: (x) => setSheet({ kind: "plan", plan: null, date: x.date, start: x.start_min, source: "finder" }),
    onMove: (p, to) => {
      const now = new Date().toISOString();
      void saveGymPlan({ ...p, ...to, updated_at: now }).then(() => flash(`Moved to ${weekdayName(to.date)} ${hm(to.start_min)}.`));
    },
  };

  let body;
  if (old && load?.status === "loading") body = <Loading label="Loading this week" heights={[320]} />;
  else if (old && load?.status === "error") body = <LoadError what="Couldn't load this week." error={load.error} onRetry={() => void loadCalendarRange(start, addDays(start, 6))} />;
  else body = list ? <WeekList days={days} act={act} /> : <WeekGrid days={days} tz={src.tz} act={act} />;

  const pickedDay = shown?.kind === "day" ? (calendarWeek(src, weekStartOf(shown.date, boot.settings.week_start), free ? finderOpts : null).days.find((d) => d.date === shown.date) ?? null) : null;
  const sheetWeek = shown && "date" in shown && shown.date ? weekDates(weekStartOf(shown.date, boot.settings.week_start)) : dates;
  const title =
    shown === null
      ? ""
      : shown.kind === "day"
        ? dateShort(shown.date)
        : shown.kind === "tap"
          ? `${dateShort(shown.date)} · ${hm(shown.start)}`
          : shown.kind === "shift"
            ? shown.shift
              ? "Edit shift"
              : "Add shift"
            : shown.kind === "plan"
              ? shown.plan
                ? shown.plan.state === "missed"
                  ? "Missed session"
                  : "Edit plan"
                : "Plan gym"
              : "Find times";
  const close = () => setSheet(null);

  return (
    <>
      <main class="page" data-testid="calendar" inert={sheet !== null}>
        <ScreenHead title="Calendar" sub="Train">
          <button type="button" class="clay press btn-sm t-muted" data-testid="cal-view-toggle" onClick={() => setList(!list)}>
            {list ? "Week view" : "List view"}
          </button>
        </ScreenHead>
        <MonthStrip
          src={src}
          start={start}
          onPick={(date) => {
            setStart(weekStartOf(date, boot.settings.week_start));
            setSheet({ kind: "day", date });
          }}
        />
        <div class="l-row l-between l-gap-8">
          <button type="button" class="clay press btn-icon t-muted" aria-label="Previous week" data-testid="cal-prev" onClick={() => step(-1)}>
            <IconBack size={20} />
          </button>
          <div class="l-col l-grow" style={{ alignItems: "center" }} aria-live="polite">
            <span class="t-title num" data-testid="cal-week-label">
              {label}
            </span>
            <span class="caption">{start === thisWeek ? "This week" : start < thisWeek ? "Past week" : "Coming week"}</span>
          </div>
          <button type="button" class="clay press btn-icon t-muted" aria-label="Next week" data-testid="cal-next-week" onClick={() => step(1)}>
            <IconChevron size={20} />
          </button>
        </div>
        <div class="l-grid-3 l-gap-8">
          <button type="button" class="clay press btn-sm btn--fit t-muted" data-testid="cal-add-shift" onClick={() => setSheet({ kind: "shift", shift: null, date: null, start: null })}>
            Add shift
          </button>
          <button
            type="button"
            class="clay press btn-sm btn--fit t-muted"
            data-testid="cal-plan"
            onClick={() => setSheet({ kind: "plan", plan: null, date: firstOpenDay, start: suggestion(firstOpenDay), source: "manual" })}
          >
            Plan gym
          </button>
          <button type="button" class="clay press btn-sm btn--fit t-pink" data-testid="cal-find-times" onClick={() => setSheet({ kind: "find" })}>
            Find times
          </button>
        </div>
        <div class="l-row l-between l-gap-8 l-wrap">
          <label class="check-chip">
            <input type="checkbox" checked={free} data-testid="cal-free" onChange={(e) => setFree((e.currentTarget as HTMLInputElement).checked)} />
            Show free times
          </label>
          {start !== thisWeek ? (
            <button type="button" class="clay press btn-sm t-muted" data-testid="cal-today" onClick={() => setStart(thisWeek)}>
              This week
            </button>
          ) : null}
        </div>
        {noShifts && !(old && load?.status !== "done") ? (
          <div class="state" data-testid="cal-empty">
            <span>No shifts this week.</span>
            <div class="l-row l-gap-8">
              <button type="button" class="clay press btn-sm btn--fit t-muted" data-testid="cal-empty-add" onClick={() => setSheet({ kind: "shift", shift: null, date: null, start: null })}>
                Add shift
              </button>
              {copies.length ? (
                <button
                  type="button"
                  class="clay press btn-sm btn--fit t-muted"
                  data-testid="cal-copy"
                  onClick={() => {
                    void (async () => {
                      for (const x of copies) await saveShift(x);
                      flash(`Copied ${plural(copies.length, "shift")} from last week.`);
                    })();
                  }}
                >
                  Copy last week
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {body}
        {list ? null : <Legend free={free} />}
        {free && week.finder && !week.finder.slots.length ? (
          <p class="caption l-m0" data-testid="cal-no-free">
            No time fits a session this week.
          </p>
        ) : null}
      </main>
      <Sheet open={sheet !== null} onClose={close} title={title} testId={shown ? `cal-${shown.kind}-sheet` : undefined}>
        {shown?.kind === "day" && pickedDay ? (
          <>
            <DayRows d={pickedDay} act={act} />
            <div class="l-grid-2 l-gap-8">
              <button type="button" class="clay press btn t-pink" onClick={() => setSheet({ kind: "plan", plan: null, date: shown.date, start: suggestion(shown.date), source: "manual" })}>
                Plan gym
              </button>
              <button type="button" class="clay press btn t-muted" onClick={() => setSheet({ kind: "shift", shift: null, date: shown.date, start: null })}>
                Add shift
              </button>
            </div>
          </>
        ) : null}
        {shown?.kind === "tap" ? <TapSheet date={shown.date} start={shown.start} src={src} onShift={() => setSheet({ kind: "shift", shift: null, date: shown.date, start: shown.start })} onClose={close} /> : null}
        {shown?.kind === "shift" ? <ShiftSheet key={shown.shift?.id ?? `${shown.date}-${shown.start}`} week={sheetWeek} shift={shown.shift} date={shown.date} start={shown.start} src={src} onClose={close} /> : null}
        {shown?.kind === "plan" ? <PlanSheet key={shown.plan?.id ?? `${shown.date}-${shown.start}`} week={sheetWeek} plan={shown.plan} date={shown.date} start={shown.start} source={shown.source} src={src} onClose={close} /> : null}
        {shown?.kind === "find" && week.finder ? <FindTimes slots={week.finder.slots} need={week.finder.need} perWeek={perWeek} src={src} onClose={close} /> : null}
      </Sheet>
    </>
  );
}
