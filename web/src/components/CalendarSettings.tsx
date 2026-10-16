// Settings → Calendar (SPEC-v10 M13, Payam's change of 2026-10-15): the defaults work as they are; every value here is
// optional. Wake-up and earliest suggestion, travel, the gap before a shift and the rest after one (and after a long
// one), the reminder, the gym's hours per weekday and preferred times. Saved on this device at once, then synced.

import { useState } from "preact/hooks";
import { DEFAULT_CALENDAR_SETTINGS, hm, WEEKDAY_KEYS, type MinuteRange, type PreferredWindow, type WeekdayKey } from "../../../worker/lib/calendar";
import { timeInput, timeValue } from "../lib/calendarView";
import { calendarSettings, saveCalendarSettings, useStore } from "../store";
import { Select } from "./Select";

/** Monday first, as the calendar shows the week. */
const DAYS: WeekdayKey[] = [...WEEKDAY_KEYS.slice(1), WEEKDAY_KEYS[0]];
const DAY_LABEL: Record<WeekdayKey, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

const minutesLabel = (m: number) => (m === 0 ? "None" : m % 60 === 0 ? `${m / 60} h` : m > 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

/** A choice of minutes; a value set elsewhere (another device, the API) stays in the list. */
function MinutesSelect({ id, label, value, options, format = minutesLabel, onPick }: { id: string; label: string; value: number; options: number[]; format?: (m: number) => string; onPick: (m: number) => void }) {
  const all = [...new Set([...options, value])].sort((a, b) => a - b);
  return (
    <div class="form-field">
      <label class="form-field__label" for={id}>
        {label}
      </label>
      <Select id={id} value={String(value)} onChange={(e) => onPick(Number((e.currentTarget as HTMLSelectElement).value))}>
        {all.map((m) => (
          <option value={String(m)}>{format(m)}</option>
        ))}
      </Select>
    </div>
  );
}

/** A time of day; saved when the picker commits a valid time. */
function TimeSetting({ id, label, value, onPick }: { id: string; label: string; value: number; onPick: (m: number) => void }) {
  return (
    <div class="form-field">
      <label class="form-field__label" for={id}>
        {label}
      </label>
      <input
        id={id}
        class="input num"
        type="time"
        value={timeValue(value)}
        onChange={(e) => {
          const m = timeInput((e.currentTarget as HTMLInputElement).value);
          if (m !== null) onPick(m);
        }}
      />
    </div>
  );
}

/** The gym's hours for one weekday: open and close (00:00 = midnight), or closed. */
function HoursRow({ day, hours, onPick }: { day: WeekdayKey; hours: MinuteRange | null; onPick: (h: MinuteRange | null) => void }) {
  const [error, setError] = useState("");
  const shown = hours ?? DEFAULT_CALENDAR_SETTINGS.gym_hours[day] ?? { start_min: 480, end_min: 1200 };
  const set = (patch: Partial<MinuteRange>) => {
    const next = { ...shown, ...patch };
    if (next.end_min <= next.start_min) return setError("Closing must be after opening.");
    setError("");
    onPick(next);
  };
  return (
    <div class="l-col l-gap-6" data-testid={`hours-${day}`}>
      <div class="l-row l-gap-8">
        <span class="t-title" style={{ width: "40px" }}>
          {DAY_LABEL[day]}
        </span>
        <input
          class="input num l-grow"
          type="time"
          aria-label={`${DAY_LABEL[day]} opens`}
          disabled={!hours}
          value={timeValue(shown.start_min)}
          onChange={(e) => {
            const m = timeInput((e.currentTarget as HTMLInputElement).value);
            if (m !== null) set({ start_min: m });
          }}
        />
        <input
          class="input num l-grow"
          type="time"
          aria-label={`${DAY_LABEL[day]} closes`}
          disabled={!hours}
          value={timeValue(shown.end_min)}
          onChange={(e) => {
            const m = timeInput((e.currentTarget as HTMLInputElement).value, true);
            if (m !== null) set({ end_min: m });
          }}
        />
        <label class="check-chip">
          <input type="checkbox" checked={!hours} onChange={(e) => onPick((e.currentTarget as HTMLInputElement).checked ? null : shown)} />
          Closed
        </label>
      </div>
      {error ? (
        <p class="caption t-orange l-m0" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Preferred times: suggestions inside one rank first (except before a long shift). */
function PreferredTimes({ windows, onPick }: { windows: PreferredWindow[]; onPick: (w: PreferredWindow[]) => void }) {
  const [days, setDays] = useState<Set<WeekdayKey>>(new Set(["mon", "tue", "wed", "thu", "fri"]));
  const [from, setFrom] = useState("17:00");
  const [to, setTo] = useState("21:00");
  const [error, setError] = useState("");
  const add = () => {
    const s = timeInput(from);
    const e = timeInput(to, true);
    if (s === null || e === null || e <= s) return setError("The time must end after it starts.");
    if (!days.size) return setError("Pick at least one day.");
    setError("");
    onPick([...windows, { days: DAYS.filter((d) => days.has(d)), start_min: s, end_min: e }]);
  };
  return (
    <div class="l-col l-gap-10" data-testid="preferred-times">
      {windows.length ? (
        <ul class="list-plain">
          {windows.map((w, i) => (
            <li class="list-row">
              <span class="list-row__text">
                <span class="t-title num">
                  {hm(w.start_min)}–{hm(w.end_min)}
                </span>
                <span class="list-row__note">{w.days.map((d) => DAY_LABEL[d]).join(", ")}</span>
              </span>
              <button type="button" class="clay press btn-sm btn--fit t-muted" onClick={() => onPick(windows.filter((_, j) => j !== i))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="caption l-m0">None: the earliest time that fits wins.</p>
      )}
      <fieldset class="form-field">
        <legend class="form-field__label">Add a preferred time</legend>
        <div class="cal-strip cal-strip--pick">
          {DAYS.map((d) => (
            <button
              type="button"
              class="cal-day press"
              aria-pressed={days.has(d)}
              onClick={() =>
                setDays((cur) => {
                  const n = new Set(cur);
                  if (n.has(d)) n.delete(d);
                  else n.add(d);
                  return n;
                })
              }
            >
              <b>{DAY_LABEL[d]}</b>
            </button>
          ))}
        </div>
      </fieldset>
      <div class="l-grid-2 l-gap-10">
        <div class="form-field">
          <label class="form-field__label" for="pref-from">
            From
          </label>
          <input id="pref-from" class="input num" type="time" value={from} onInput={(e) => setFrom((e.currentTarget as HTMLInputElement).value)} />
        </div>
        <div class="form-field">
          <label class="form-field__label" for="pref-to">
            To
          </label>
          <input id="pref-to" class="input num" type="time" value={to} onInput={(e) => setTo((e.currentTarget as HTMLInputElement).value)} />
        </div>
      </div>
      {error ? (
        <p class="caption t-orange l-m0" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" class="clay press btn t-muted" data-testid="preferred-add" onClick={add}>
        Add preferred time
      </button>
    </div>
  );
}

export function CalendarSettingsCard() {
  const boot = useStore((s) => s.boot)!;
  const cs = calendarSettings(boot);
  const set = (patch: Parameters<typeof saveCalendarSettings>[0]) => void saveCalendarSettings(patch);
  return (
    <section class="card l-col l-gap-14" aria-label="Calendar" data-testid="calendar-settings">
      <p class="caption l-m0">The app suggests gym times from your shifts with these. They work as they are: change one only if you want to.</p>
      <div class="l-grid-2 l-gap-10">
        <TimeSetting id="cal-wake" label="Wake up" value={cs.wake_time_min} onPick={(m) => set({ wake_time_min: m })} />
        <TimeSetting id="cal-earliest" label="Earliest suggestion" value={cs.earliest_start_min} onPick={(m) => set({ earliest_start_min: m })} />
      </div>
      <MinutesSelect id="cal-travel" label="Travel to the gym, each way" value={cs.travel_buffer_min} options={[0, 5, 10, 15, 20, 25, 30, 40, 45, 60]} onPick={(m) => set({ travel_buffer_min: m })} />
      <MinutesSelect id="cal-before" label="Finish the gym before a shift starts" value={cs.before_shift_gap_min} options={[30, 45, 60, 75, 90, 120]} onPick={(m) => set({ before_shift_gap_min: m })} />
      <div class="l-grid-2 l-gap-10">
        <MinutesSelect id="cal-after" label="Rest after a shift" value={cs.after_shift_gap_min} options={[0, 15, 30, 45, 60, 90]} onPick={(m) => set({ after_shift_gap_min: m })} />
        <MinutesSelect id="cal-after-long" label="After a long shift" value={cs.long_shift_gap_min} options={[30, 45, 60, 90, 120, 150, 180]} onPick={(m) => set({ long_shift_gap_min: m })} />
      </div>
      <MinutesSelect
        id="cal-long"
        label="A long shift is"
        value={cs.long_shift_min}
        options={[360, 420, 480, 540, 600, 660, 720]}
        format={(m) => `${minutesLabel(m)} or more`}
        onPick={(m) => set({ long_shift_min: m })}
      />
      <MinutesSelect
        id="cal-reminder"
        label="Reminder before a planned session"
        value={cs.reminder_minutes}
        options={[0, 15, 30, 45, 60, 90, 120]}
        format={(m) => (m === 0 ? "Off" : `${minutesLabel(m)} before`)}
        onPick={(m) => set({ reminder_minutes: m })}
      />
      <p class="caption l-m0">Reminders use the notifications you turn on below (Rest-timer notification).</p>
      <fieldset class="form-field" data-testid="gym-hours">
        <legend class="form-field__label">Gym hours</legend>
        <div class="l-col l-gap-8">
          {DAYS.map((d) => (
            <HoursRow day={d} hours={cs.gym_hours[d]} onPick={(h) => set({ gym_hours: { ...cs.gym_hours, [d]: h } })} />
          ))}
        </div>
      </fieldset>
      <fieldset class="form-field">
        <legend class="form-field__label">Preferred times</legend>
        <PreferredTimes windows={cs.preferred_windows} onPick={(w) => set({ preferred_windows: w })} />
      </fieldset>
    </section>
  );
}
