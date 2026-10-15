// Training calendar (SPEC-v10 M13): the week strip at the top of Home, and the Calendar screen it opens (a pushed
// screen): the month strip, the week grid (04:00–24:00, work shifts, planned / done / missed gym sessions, free times
// from the shared finder) and its List view, all from the data on this device.

import { useEffect, useRef, useState } from "preact/hooks";
import { DAY_END_MIN, DAY_START_MIN, hm, toMin, weekDates, type FreeSlot, type SessionBlock, type WorkShift } from "../../../worker/lib/calendar";
import { addDays, localHM } from "../../../worker/lib/time";
import { Sheet } from "../components/Sheet";
import { ScreenHead } from "../components/ScreenHead";
import { IconBack, IconChevron } from "../components/PulseIcons";
import { LoadError, Loading } from "../components/States";
import { dateShort, monthLabel } from "../format";
import { EDGE_ZONE } from "../lib/nav";
import {
  blockLabel,
  calendarWeek,
  dayChips,
  dayNumber,
  gridPlace,
  monthDates,
  nextLine,
  nextPlan,
  timeRange,
  upcomingFor,
  weekdayName,
  weekLabel,
  weekStartOf,
  type CalendarDay,
  type CalendarSource,
  type DayChip,
  type ShownPlan,
} from "../lib/calendarView";
import { dayInfo, daysPerWeek, homeModel } from "../model";
import { calendarSettings, getState, loadCalendarRange, openCalendar, today, useStore } from "../store";

/** An hour of the week grid, in CSS pixels: the 44 pt touch row (SPEC-v10 §7). */
const HOUR_PX = 44;
const HOURS = Array.from({ length: (DAY_END_MIN - DAY_START_MIN) / 60 }, (_, i) => DAY_START_MIN + i * 60);

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
 * planned session under it. Tapping it opens the Calendar.
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
        <button type="button" class="clay press btn-sm btn--fit t-pink" style={{ alignSelf: "flex-start" }} data-testid="cal-find" onClick={() => openCalendar({ free: true })}>
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

function Block({ kind, r, label, title, sub }: { kind: "work" | "plan" | "done" | "missed" | "free"; r: { start_min: number; end_min: number }; label: string; title: string; sub: string }) {
  const p = gridPlace(r, DAY_START_MIN, DAY_END_MIN, HOUR_PX);
  return (
    <div class={`cal-block cal-block--${kind}`} style={{ "--top": `${p.top}px`, "--h": `${p.height}px` }} role="img" aria-label={label} data-kind={kind} data-start={hm(r.start_min)}>
      <span class="cal-block__label" aria-hidden="true">
        <span>{title}</span>
        <span class="cal-block__time">{sub}</span>
      </span>
    </div>
  );
}

const shortDay = (name: string) => name.split(" · ")[0];

/** The week grid: 7 day columns over 04:00–24:00 with every block; swipe left or right for the next or previous week. */
function WeekGrid({ days, onWeek, tz }: { days: CalendarDay[]; onWeek: (step: 1 | -1) => void; tz: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Opens on the current time of day (an hour of context above it).
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = Math.max(0, ((nowMin(tz) - DAY_START_MIN) / 60 - 1) * HOUR_PX);
  }, []);
  const swipe = useRef<{ id: number; x: number; y: number } | null>(null);
  const down = (e: PointerEvent) => {
    // The left edge belongs to the swipe back (Pushed).
    if (e.isPrimary && e.clientX > EDGE_ZONE) swipe.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const up = (e: PointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) >= 60 && Math.abs(dx) > 2 * Math.abs(dy)) onWeek(dx < 0 ? 1 : -1);
  };
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
            <div class="cal-col" role="group" aria-label={dateShort(d.date)} data-date={d.date} data-testid="cal-col">
              {HOURS.map(() => (
                <span class="cal-cell" />
              ))}
              {d.shifts.map((x) => (
                <Block kind="work" r={x} label={blockLabel.shift(x)} title="Work" sub={hm(x.start_min)} />
              ))}
              {d.free.map((x) => (
                <Block kind="free" r={x} label={blockLabel.free(x)} title="Free" sub={hm(x.start_min)} />
              ))}
              {d.plans.map((p) => (
                <Block kind={p.state === "missed" ? "missed" : "plan"} r={p} label={blockLabel.plan(p, dayName(p.program_day_id))} title={p.state === "missed" ? "Missed" : shortDay(dayName(p.program_day_id))} sub={hm(p.start_min)} />
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

type Row = { key: string; kind: "work" | "plan" | "done" | "missed" | "free"; title: string; note: string; r: { start_min: number; end_min: number } };

function dayRows(d: CalendarDay): Row[] {
  const rows: Row[] = [
    ...d.shifts.map((x: WorkShift): Row => ({ key: x.id, kind: "work", title: "Work", note: x.note, r: x })),
    ...d.plans.map((p: ShownPlan): Row => ({ key: p.id, kind: p.state === "missed" ? "missed" : "plan", title: p.state === "missed" ? "Missed" : "Planned", note: dayName(p.program_day_id), r: p })),
    ...d.sessions.map((b: SessionBlock): Row => ({ key: b.id, kind: "done", title: b.status === "active" ? "In progress" : "Done", note: dayName(b.program_day_id), r: b })),
    ...d.free.map((x: FreeSlot): Row => ({ key: `free:${x.start_min}`, kind: "free", title: "Free time", note: x.preferred ? "In a preferred window" : "", r: x })),
  ];
  return rows.sort((a, b) => a.r.start_min - b.r.start_min);
}

/** A row's mark: the bar of a shift, the dot of a gym session or a free time. */
const Mark = ({ kind }: { kind: Row["kind"] }) => (
  <span class="cal-mark" aria-hidden="true">
    {kind === "work" ? <span class="cal-shift" /> : <span class="cal-dot" data-kind={kind === "plan" ? "planned" : kind} />}
  </span>
);

/** One day's shifts, plans, sessions and free times as rows (the List view and the day sheet). */
function DayRows({ d }: { d: CalendarDay }) {
  const rows = dayRows(d);
  if (!rows.length) return <p class="caption l-m0" style={{ padding: "10px 0" }}>Nothing on this day.</p>;
  return (
    <ul class="list-plain">
      {rows.map((r) => (
        <li class="list-row" data-kind={r.kind} data-testid="cal-row">
          <Mark kind={r.kind} />
          <span class="list-row__text">
            <span class="t-title">{r.title}</span>
            {r.note ? <span class="list-row__note">{r.note}</span> : null}
          </span>
          <span class="list-row__value">{timeRange(r.r)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The List view (SPEC-v10 §7): the week day by day, the accessible alternative to the grid. */
function WeekList({ days }: { days: CalendarDay[] }) {
  return (
    <section class="card card--list" aria-label="Week as a list" data-testid="cal-list">
      {days.map((d) => (
        <div data-date={d.date}>
          <h3 class="card__title l-m0">
            {dateShort(d.date)}
            {d.today ? " · Today" : ""}
          </h3>
          <DayRows d={d} />
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
  const [picked, setPicked] = useState<string | null>(null);

  // Weeks older than the bootstrap's 60 days come from the server.
  const old = start < addDays(src.today, -60);
  useEffect(() => {
    if (old) void loadCalendarRange(start, addDays(start, 6));
  }, [start]);

  const finder = free ? { upcoming: upcomingFor(boot.program.days, homeModel(boot, sessions, src.today).next.dayId, src.plans, src.today), days_per_week: daysPerWeek(boot), now_min: nowMin(src.tz) } : null;
  const week = calendarWeek(src, start, finder);
  const pickedDay = picked ? calendarWeek(src, weekStartOf(picked, boot.settings.week_start), finder).days.find((d) => d.date === picked) ?? null : null;
  const step = (n: 1 | -1) => setStart((s) => addDays(s, 7 * n));
  const label = weekLabel(start, src.today);

  let body;
  if (old && load?.status === "loading") body = <Loading label="Loading this week" heights={[320]} />;
  else if (old && load?.status === "error") body = <LoadError what="Couldn't load this week." error={load.error} onRetry={() => void loadCalendarRange(start, addDays(start, 6))} />;
  else body = list ? <WeekList days={week.days} /> : <WeekGrid days={week.days} onWeek={step} tz={src.tz} />;

  return (
    <>
      <main class="page" data-testid="calendar" inert={picked !== null}>
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
            setPicked(date);
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
        {body}
        {list ? null : <Legend free={free} />}
        {free && week.finder && !week.finder.slots.length ? (
          <p class="caption l-m0" data-testid="cal-no-free">
            {week.finder.need ? "No free time fits a session this week." : "This week's sessions are all done or planned."}
          </p>
        ) : null}
      </main>
      <Sheet open={pickedDay !== null} onClose={() => setPicked(null)} title={picked ? dateShort(picked) : ""} testId="cal-day-sheet">
        {pickedDay ? <DayRows d={pickedDay} /> : null}
      </Sheet>
    </>
  );
}
