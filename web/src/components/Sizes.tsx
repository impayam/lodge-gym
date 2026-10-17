// Body sizes (SPEC-v12 M15 §4): logged any time, in cm whatever the weight unit, any of eight fields per entry. The
// latest value of each field shows as a pressed-in tile with its change since the entry before; Log sizes opens a sheet
// (a date and the eight fields, all optional); All sizes lists every entry with delete. Everything works offline.

import { useState } from "preact/hooks";
import { parseNumber } from "../../../worker/lib/digits";
import { SIZE_FIELDS, SIZE_NAME, latestSizes, sizeKey, type BodyMeasurement, type SizeField } from "../../../worker/lib/measurements";
import { DATE_RE } from "../../../worker/lib/time";
import { ulid } from "../../../worker/lib/ulid";
import { dayMonth, dateLong, fmtNum } from "../format";
import { deleteMeasurement, saveMeasurement, today, useStore } from "../store";
import { ScreenHead } from "./ScreenHead";
import { Sheet } from "./Sheet";
import { Empty } from "./States";

const MIN_CM = 10;
const MAX_CM = 300;

const signed = (n: number) => `${n > 0 ? "▲" : n < 0 ? "▼" : ""}${fmtNum(Math.abs(n), 1)}`;

/** The latest sizes as tiles (value and change since the entry before). */
export function SizeTiles() {
  const list = useStore((s) => s.boot!.measurements ?? []);
  const latest = latestSizes(list);
  if (!latest.length) return <p class="caption l-m0">No sizes yet. Log arm, chest, waist and the others any time, in cm.</p>;
  const last = latest.reduce((m, s) => (s.date > m ? s.date : m), latest[0].date);
  const since = latest.filter((s) => s.date === last && s.since).map((s) => s.since!).sort()[0];
  return (
    <>
      <div class="l-grid-3 l-gap-8" role="list" aria-label="Latest sizes, cm" data-testid="size-tiles">
        {latest.map((s) => (
          <div class="well size-tile" role="listitem" data-size={s.field}>
            <span class="size-tile__label">{SIZE_NAME[s.field]}</span>
            <span class="size-tile__value num">
              {fmtNum(s.value, 1)}{" "}
              <small data-down={s.change !== null && s.change < 0 ? "true" : "false"}>
                {s.change === null ? "–" : signed(s.change)}
                <span class="l-sr">{s.change === null ? ", first entry" : ` cm since ${dateLong(s.since!)}`}</span>
              </small>
            </span>
          </div>
        ))}
      </div>
      <span class="caption num">
        Measured {dayMonth(last)}
        {since ? ` · change since ${dayMonth(since)}` : ""}
      </span>
    </>
  );
}

/** Log sizes: a date and the eight fields in cm, all optional; at least one is needed to save. */
export function SizesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [date, setDate] = useState(today());
  const [values, setValues] = useState<Partial<Record<SizeField, string>>>({});
  const [msg, setMsg] = useState("");
  const parsed = SIZE_FIELDS.map((f) => [f, values[f]?.trim() ? parseNumber(values[f]!) : null] as const);
  const bad = parsed.find(([f, v]) => values[f]?.trim() && (v === null || v < MIN_CM || v > MAX_CM));
  const any = parsed.some(([, v]) => v !== null);
  const close = () => {
    setValues({});
    setMsg("");
    setDate(today());
    onClose();
  };
  const save = () => {
    if (!DATE_RE.test(date) || date > today()) return setMsg("Pick a date up to today.");
    if (bad) return setMsg(`${SIZE_NAME[bad[0]]}: enter ${MIN_CM}–${MAX_CM} cm.`);
    if (!any) return setMsg("Enter at least one size.");
    const now = new Date().toISOString();
    const doc: BodyMeasurement = {
      id: ulid(),
      local_date: date,
      arm_cm: null,
      chest_cm: null,
      waist_cm: null,
      hips_cm: null,
      thigh_cm: null,
      calf_cm: null,
      neck_cm: null,
      shoulders_cm: null,
      note: "",
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    for (const [f, v] of parsed) doc[sizeKey(f)] = v === null ? null : Math.round(v * 10) / 10;
    void saveMeasurement(doc);
    close();
  };
  return (
    <Sheet open={open} onClose={close} title="Log sizes" sub="cm, all optional" testId="sizes-sheet">
      <div class="form-field">
        <label class="form-field__label" for="size-date">
          Date
        </label>
        <input id="size-date" class="input num" type="date" max={today()} value={date} onInput={(e) => setDate((e.currentTarget as HTMLInputElement).value)} />
      </div>
      <div class="l-grid-2 l-gap-8">
        {SIZE_FIELDS.map((f) => (
          <div class="form-field">
            <label class="form-field__label" for={`size-${f}`}>
              {SIZE_NAME[f]} (cm)
            </label>
            <input
              id={`size-${f}`}
              class="input num"
              inputMode="decimal"
              autocomplete="off"
              data-testid={`size-${f}`}
              value={values[f] ?? ""}
              aria-invalid={bad?.[0] === f ? "true" : undefined}
              onInput={(e) => {
                setMsg("");
                setValues((v) => ({ ...v, [f]: (e.currentTarget as HTMLInputElement).value }));
              }}
            />
          </div>
        ))}
      </div>
      {msg ? (
        <span class="caption t-orange" role="alert">
          {msg}
        </span>
      ) : null}
      <button type="button" class="clay press btn t-pink" data-testid="sizes-save" onClick={save}>
        Save
      </button>
    </Sheet>
  );
}

/** All sizes: every entry, newest first, with a two-step delete. */
export function AllSizes() {
  const list = useStore((s) => s.boot!.measurements ?? []);
  const [armed, setArmed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const rows = [...list].reverse();
  return (
    <main class="page" data-testid="all-sizes">
      <ScreenHead title="All sizes" sub="Profile · cm">
        <button type="button" class="clay press btn-sm btn--fit t-pink" data-testid="sizes-log" onClick={() => setOpen(true)}>
          Log sizes
        </button>
      </ScreenHead>
      {rows.length ? (
        <section class="card card--list" aria-label="Size entries">
          {rows.map((m) => (
            <div class="list-row" data-testid="size-row" data-id={m.id}>
              <span class="list-row__text">
                <span class="t-title num">{dateLong(m.local_date)}</span>
                <span class="caption num">
                  {SIZE_FIELDS.filter((f) => m[sizeKey(f)] != null)
                    .map((f) => `${SIZE_NAME[f]} ${fmtNum(m[sizeKey(f)]!, 1)}`)
                    .join(" · ")}
                </span>
              </span>
              <button
                type="button"
                class="clay press btn-sm btn--fit t-danger"
                data-testid="size-delete"
                aria-label={armed === m.id ? `Sure? Delete the entry of ${dateLong(m.local_date)}` : `Delete the entry of ${dateLong(m.local_date)}`}
                onClick={() => {
                  if (armed !== m.id) return setArmed(m.id);
                  setArmed(null);
                  void deleteMeasurement(m.id);
                }}
              >
                {armed === m.id ? "Sure? Delete" : "Delete"}
              </button>
            </div>
          ))}
        </section>
      ) : (
        <section class="card">
          <Empty action={{ label: "Log sizes", onClick: () => setOpen(true), testId: "sizes-empty-log" }}>No sizes yet.</Empty>
        </section>
      )}
      <SizesSheet open={open} onClose={() => setOpen(false)} />
    </main>
  );
}
