// Exercise library (SPEC-v2 §7.3): search with muscle / equipment / pattern filters, a detail view with media,
// instructions, muscles and your history with the exercise, custom exercises (create, edit, archive, photo), and the
// same list as a picker for adding an exercise to the session.

import { useEffect, useMemo, useState } from "preact/hooks";
import { CATEGORIES, countsVolume, type Category } from "../../../worker/lib/category";
import { CANONICAL_MUSCLES } from "../../../worker/lib/muscles";
import { bestSet } from "../../../worker/lib/reports";
import type { Exercise, Pattern, SetEntry, WorkoutSession } from "../../../worker/lib/types";
import { ulid } from "../../../worker/lib/ulid";
import { errorText } from "../api";
import { LineChart } from "../components/Charts";
import { dateLong, dayMonth, fmtNum, ytLink } from "../format";
import { loadAllHistory, loadLibrary, mediaSrc, saveCustomExercise, uploadCustomPhoto, useStore, type CustomExerciseInput } from "../store";

export const MUSCLE_LABEL: Record<string, string> = {
  chest: "Chest",
  back_lats: "Lats",
  back_upper: "Upper back",
  quads: "Quads",
  hamstrings: "Hamstrings",
  glutes: "Glutes",
  shoulders_front: "Front delts",
  shoulders_side: "Side delts",
  rear_delts: "Rear delts",
  biceps: "Biceps",
  triceps: "Triceps",
  calves: "Calves",
  core: "Core",
  forearms: "Forearms",
  traps: "Traps",
  adductors: "Adductors",
  abductors: "Abductors",
  lower_back: "Lower back",
  neck: "Neck",
  // Report groups (rows written before SPEC-v2).
  back: "Back",
  hamstrings_glutes: "Hamstrings & glutes",
  shoulders: "Shoulders",
};
export const muscleLabel = (m: string) => MUSCLE_LABEL[m] ?? m;

const EQUIPMENT: [Exercise["equipment"], string][] = [
  ["barbell", "Barbell"],
  ["dumbbell", "Dumbbell"],
  ["cable", "Cable"],
  ["machine", "Machine"],
  ["bodyweight", "Bodyweight"],
];
export const equipmentLabel = (e: string) => EQUIPMENT.find(([k]) => k === e)?.[1] ?? e;

export const PATTERN_LABEL: Record<Pattern, string> = {
  squat: "Squat",
  hinge: "Hinge",
  lunge: "Lunge",
  h_push: "Horizontal push",
  v_push: "Vertical push",
  h_pull: "Horizontal pull",
  v_pull: "Vertical pull",
  isolation: "Isolation",
  core: "Core",
  carry: "Carry",
};
export const CATEGORY_LABEL: Record<Category, string> = {
  strength: "Strength",
  powerlifting: "Powerlifting",
  olympic_weightlifting: "Olympic weightlifting",
  strongman: "Strongman",
  stretching: "Stretching",
  plyometrics: "Plyometrics",
  cardio: "Cardio",
};
const SOURCE_LABEL: Record<Exercise["source"], string> = { seed: "Program", fedb: "free-exercise-db", manual: "Added by hand", custom: "Your exercise" };

/** "Watch form video" link: a YouTube search for the English name + " form", built at render time. */
export function FormVideoLink({ name }: { name: string }) {
  return (
    <a class="formlink" href={ytLink(name)} target="_blank" rel="noopener noreferrer">
      Watch form video ↗
    </a>
  );
}

export function ExerciseThumb({ ex }: { ex: Exercise }) {
  const m = ex.media[0];
  return m ? <img class="exthumb" src={mediaSrc(m)} alt="" loading="lazy" /> : <span class="exthumb placeholder" aria-hidden="true" />;
}

interface Filters {
  q: string;
  muscle: string;
  equipment: string;
  pattern: string;
}

function matches(ex: Exercise, f: Filters): boolean {
  if (f.muscle && ex.muscle_primary !== f.muscle && !ex.muscles_secondary.includes(f.muscle)) return false;
  if (f.equipment && ex.equipment !== f.equipment) return false;
  if (f.pattern && ex.pattern !== f.pattern) return false;
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const name = ex.name_en.toLowerCase();
  return words.every((w) => name.includes(w));
}

const PAGE = 60;

/** Searchable, filterable exercise list. Used by the Library tab and by the session's "+ Add exercise". */
export function ExerciseList({ onOpen, archived = false, testId }: { onOpen: (ex: Exercise) => void; archived?: boolean; testId?: string }) {
  const library = useStore((s) => s.library);
  const [f, setF] = useState<Filters>({ q: "", muscle: "", equipment: "", pattern: "" });
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => {
    void loadLibrary();
  }, []);
  const list = useMemo(() => (library ?? []).filter((e) => (archived || !e.archived_at) && matches(e, f)), [library, f, archived]);
  const set = (patch: Partial<Filters>) => {
    setF({ ...f, ...patch });
    setLimit(PAGE);
  };
  return (
    <div class="stack" data-testid={testId}>
      <input class="search" type="search" placeholder="Search exercises" aria-label="Search exercises" value={f.q} onInput={(e) => set({ q: (e.currentTarget as HTMLInputElement).value })} />
      <div class="filters">
        <select aria-label="Muscle" value={f.muscle} onChange={(e) => set({ muscle: (e.currentTarget as HTMLSelectElement).value })}>
          <option value="">All muscles</option>
          {CANONICAL_MUSCLES.map((m) => (
            <option value={m}>{muscleLabel(m)}</option>
          ))}
        </select>
        <select aria-label="Equipment" value={f.equipment} onChange={(e) => set({ equipment: (e.currentTarget as HTMLSelectElement).value })}>
          <option value="">All equipment</option>
          {EQUIPMENT.map(([k, label]) => (
            <option value={k}>{label}</option>
          ))}
        </select>
        <select aria-label="Pattern" value={f.pattern} onChange={(e) => set({ pattern: (e.currentTarget as HTMLSelectElement).value })}>
          <option value="">All patterns</option>
          {(Object.keys(PATTERN_LABEL) as Pattern[]).map((p) => (
            <option value={p}>{PATTERN_LABEL[p]}</option>
          ))}
        </select>
      </div>
      {library === null ? (
        <div class="empty">Loading the library…</div>
      ) : (
        <>
          <small class="muted" data-testid="library-count">
            {fmtNum(list.length)} {list.length === 1 ? "exercise" : "exercises"}
          </small>
          <div class="exlist">
            {list.slice(0, limit).map((ex) => (
              <button type="button" class="exrow" data-testid="library-row" data-id={ex.id} onClick={() => onOpen(ex)}>
                <ExerciseThumb ex={ex} />
                <span class="meta">
                  <b>{ex.name_en}</b>
                  <small>
                    {muscleLabel(ex.muscle_primary)} · {equipmentLabel(ex.equipment)}
                    {ex.pattern ? ` · ${PATTERN_LABEL[ex.pattern]}` : ""}
                    {ex.archived_at ? " · archived" : ""}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {list.length > limit ? (
            <button type="button" class="btn btn-ghost btn-block" onClick={() => setLimit(limit + PAGE)}>
              Show more
            </button>
          ) : null}
          {!list.length ? <div class="empty">No exercise matches.</div> : null}
        </>
      )}
    </div>
  );
}

const setLine = (x: SetEntry, unit: string) => (x.seconds != null ? `${fmtNum(x.seconds)} s` : `${x.weight != null ? `${fmtNum(x.weight)} ${unit} × ` : ""}${fmtNum(x.reps)}`);

/** Your history with one exercise: last sets, best estimated 1RM and the best-set trend, from every program. */
function ExerciseHistory({ ex }: { ex: Exercise }) {
  const sessions = useStore((s) => s.sessions);
  const unit = useStore((s) => s.boot!.settings.unit);
  useEffect(() => {
    void loadAllHistory();
  }, []);
  const withEx = Object.values(sessions)
    .filter((s) => s.sets.some((x) => x.exercise_id === ex.id && x.done))
    .sort((a, b) => (a.local_date + a.started_at).localeCompare(b.local_date + b.started_at));
  if (!withEx.length)
    return (
      <div class="empty" data-testid="exercise-history">
        No sets logged with this exercise yet.
      </div>
    );
  const last: WorkoutSession = withEx[withEx.length - 1];
  const lastSets = last.sets.filter((x) => x.exercise_id === ex.id && x.done).sort((a, b) => a.set_index - b.set_index);
  const points = withEx.map((s) => ({ date: s.local_date, best: bestSet(s, ex.id, unit) })).filter((p) => p.best);
  const best = points.reduce<(typeof points)[number] | null>((b, p) => (!b || p.best!.e1rm > b.best!.e1rm ? p : b), null);
  return (
    <div class="stack" data-testid="exercise-history">
      <div class="kv">
        <span>Last time ({dateLong(last.local_date)})</span>
        <span class="num">{lastSets.map((x) => setLine(x, last.unit)).join(", ")}</span>
      </div>
      <div class="kv">
        <span>Best estimated 1RM</span>
        <span class="num" data-testid="best-e1rm">
          {best ? `${fmtNum(best.best!.e1rm, 1)} ${unit} (${fmtNum(best.best!.weight, 1)}×${fmtNum(best.best!.reps)}, ${dayMonth(best.date)})` : "–"}
        </span>
      </div>
      <div class="kv">
        <span>Sessions</span>
        <span class="num">{fmtNum(withEx.length)}</span>
      </div>
      {points.length ? <LineChart points={points.map((p) => ({ x: p.date, y: p.best!.e1rm, label: dayMonth(p.date) }))} valueLabel={`${unit} e1RM`} height={120} /> : null}
    </div>
  );
}

function CustomForm({ initial, onDone, onCancel }: { initial: Exercise | null; onDone: (ex: Exercise) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name_en ?? "");
  const [primary, setPrimary] = useState(initial?.muscle_primary ?? "chest");
  const [secondary, setSecondary] = useState<string[]>(initial?.muscles_secondary ?? []);
  const [equipment, setEquipment] = useState<Exercise["equipment"]>(initial?.equipment ?? "dumbbell");
  const [pattern, setPattern] = useState<Pattern | "">(initial?.pattern ?? "");
  const [category, setCategory] = useState<Category>(initial?.category ?? "strength");
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const input: CustomExerciseInput = {
        name_en: name.trim(),
        muscle_primary: primary,
        muscles_secondary: secondary.filter((m) => m !== primary),
        equipment,
        pattern: pattern || null,
        category,
        archived: Boolean(initial?.archived_at),
      };
      let ex = await saveCustomExercise(initial?.id ?? ulid(), input);
      if (photo) ex = await uploadCustomPhoto(ex, photo);
      onDone(ex);
    } catch (e) {
      setErr(e instanceof Error && e.message === "network" ? "You're offline. Custom exercises are saved online; try again when connected." : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="card stack" data-testid="custom-form">
      <b>{initial ? "Edit exercise" : "New custom exercise"}</b>
      <div class="field">
        <label for="cx-name">Name</label>
        <input id="cx-name" value={name} maxLength={80} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
      </div>
      <div class="field">
        <label for="cx-primary">Primary muscle</label>
        <select id="cx-primary" value={primary} onChange={(e) => setPrimary((e.currentTarget as HTMLSelectElement).value)}>
          {CANONICAL_MUSCLES.map((m) => (
            <option value={m}>{muscleLabel(m)}</option>
          ))}
        </select>
      </div>
      <fieldset class="field chipset">
        <legend class="lbl">Secondary muscles</legend>
        {CANONICAL_MUSCLES.filter((m) => m !== primary).map((m) => (
          <label class="chipcheck">
            <input
              type="checkbox"
              checked={secondary.includes(m)}
              onChange={(e) => setSecondary((e.currentTarget as HTMLInputElement).checked ? [...secondary, m] : secondary.filter((x) => x !== m))}
            />
            {muscleLabel(m)}
          </label>
        ))}
      </fieldset>
      <div class="field">
        <label for="cx-eq">Equipment</label>
        <select id="cx-eq" value={equipment} onChange={(e) => setEquipment((e.currentTarget as HTMLSelectElement).value as Exercise["equipment"])}>
          {EQUIPMENT.map(([k, label]) => (
            <option value={k}>{label}</option>
          ))}
        </select>
      </div>
      <div class="field">
        <label for="cx-pattern">Pattern</label>
        <select id="cx-pattern" value={pattern} onChange={(e) => setPattern((e.currentTarget as HTMLSelectElement).value as Pattern | "")}>
          <option value="">None</option>
          {(Object.keys(PATTERN_LABEL) as Pattern[]).map((p) => (
            <option value={p}>{PATTERN_LABEL[p]}</option>
          ))}
        </select>
      </div>
      <div class="field">
        <label for="cx-category">Category</label>
        <select id="cx-category" value={category} onChange={(e) => setCategory((e.currentTarget as HTMLSelectElement).value as Category)}>
          {CATEGORIES.map((k) => (
            <option value={k}>{CATEGORY_LABEL[k]}</option>
          ))}
        </select>
      </div>
      <div class="field">
        <label for="cx-photo">Photo (optional)</label>
        <input id="cx-photo" type="file" accept="image/*" onChange={(e) => setPhoto((e.currentTarget as HTMLInputElement).files?.[0] ?? null)} />
      </div>
      <div class="row">
        <button type="button" class="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>
          Save
        </button>
        <button type="button" class="btn btn-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {err ? (
        <div class="err" role="alert">
          {err}
        </div>
      ) : null}
    </section>
  );
}

function ExerciseDetail({ ex, onBack, onEdit }: { ex: Exercise; onBack: () => void; onEdit: () => void }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const archive = async (archived: boolean) => {
    setBusy(true);
    setErr("");
    try {
      await saveCustomExercise(ex.id, { name_en: ex.name_en, muscle_primary: ex.muscle_primary, muscles_secondary: ex.muscles_secondary, equipment: ex.equipment, pattern: ex.pattern, category: ex.category ?? undefined, archived });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const images = ex.media.filter((m) => m.kind === "image" || m.kind === "gif");
  return (
    <div class="stack" data-testid="exercise-detail">
      <button type="button" class="linkbtn" onClick={onBack}>
        ← Back to the library
      </button>
      <h2 style={{ margin: "4px 0 0" }}>{ex.name_en}</h2>
      {/* A missing category only comes from a copy cached before the category existed: say nothing rather than guess. */}
      {!ex.category || countsVolume(ex.category) ? null : (
        <p class="muted" data-testid="not-counted" style={{ margin: 0 }}>
          <span class="pill">Not counted in volume</span> Sets are logged, but count 0 toward weekly muscle volume and the muscle map.
        </p>
      )}
      {images.length ? (
        <div class="exmedia">
          {images.slice(0, 2).map((m, i) => (
            <img src={mediaSrc(m)} alt={`${ex.name_en}, ${i === 0 ? "start" : "end"} position`} loading="lazy" />
          ))}
        </div>
      ) : (
        <div class="exmedia none" data-testid="media-placeholder">
          <span>No image</span>
        </div>
      )}
      <FormVideoLink name={ex.name_en} />
      <div class="card stack">
        <div class="kv">
          <span>Primary muscle</span>
          <span>{muscleLabel(ex.muscle_primary)}</span>
        </div>
        <div class="kv">
          <span>Secondary muscles</span>
          <span>{ex.muscles_secondary.length ? ex.muscles_secondary.map(muscleLabel).join(", ") : "–"}</span>
        </div>
        <div class="kv">
          <span>Equipment</span>
          <span>{equipmentLabel(ex.equipment)}</span>
        </div>
        <div class="kv">
          <span>Pattern</span>
          <span>{ex.pattern ? PATTERN_LABEL[ex.pattern] : "–"}</span>
        </div>
        <div class="kv">
          <span>Category</span>
          <span data-testid="category">{ex.category ? CATEGORY_LABEL[ex.category] : "–"}</span>
        </div>
        <div class="kv">
          <span>Mechanic · level</span>
          <span>
            {ex.mechanic ?? "–"} · {ex.level ?? "–"}
          </span>
        </div>
        <div class="kv">
          <span>Source</span>
          <span>{SOURCE_LABEL[ex.source]}</span>
        </div>
      </div>
      {ex.cue_en ? <p class="cue">{ex.cue_en}</p> : null}
      {ex.instructions_en.length ? (
        <>
          <h2>Instructions</h2>
          <ol class="rules">
            {ex.instructions_en.map((s) => (
              <li>{s}</li>
            ))}
          </ol>
        </>
      ) : null}
      <h2>Your history</h2>
      <div class="card">
        <ExerciseHistory ex={ex} />
      </div>
      {ex.source === "custom" ? (
        <div class="row">
          <button type="button" class="btn btn-ghost" disabled={busy} onClick={onEdit}>
            Edit
          </button>
          <button type="button" class="btn btn-ghost" disabled={busy} data-testid="archive" onClick={() => void archive(!ex.archived_at)}>
            {ex.archived_at ? "Restore" : "Archive"}
          </button>
        </div>
      ) : null}
      {err ? (
        <div class="err" role="alert">
          {err}
        </div>
      ) : null}
    </div>
  );
}

export function Library() {
  const library = useStore((s) => s.library);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ edit: Exercise | null } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const open = openId ? (library ?? []).find((e) => e.id === openId) : null;
  if (form)
    return (
      <CustomForm
        initial={form.edit}
        onCancel={() => setForm(null)}
        onDone={(ex) => {
          setForm(null);
          setOpenId(ex.id);
        }}
      />
    );
  if (open) return <ExerciseDetail ex={open} onBack={() => setOpenId(null)} onEdit={() => setForm({ edit: open })} />;
  return (
    <>
      <div class="kv navrow">
        <h2 style={{ margin: 0 }}>Library</h2>
        <button type="button" class="btn btn-ghost btn-small" data-testid="new-custom" onClick={() => setForm({ edit: null })}>
          + Custom exercise
        </button>
      </div>
      <label class="chipcheck" style={{ marginBottom: "8px" }}>
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived((e.currentTarget as HTMLInputElement).checked)} />
        Show archived exercises
      </label>
      <ExerciseList onOpen={(ex) => setOpenId(ex.id)} archived={showArchived} testId="library" />
    </>
  );
}

/** Full-screen picker for "+ Add exercise" inside a session. */
export function ExercisePicker({ onPick, onCancel }: { onPick: (ex: Exercise) => void; onCancel: () => void }) {
  return (
    <section class="stack" data-testid="exercise-picker">
      <div class="kv navrow">
        <h2 style={{ margin: 0 }}>Add an exercise</h2>
        <button type="button" class="linkbtn" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p class="why" style={{ margin: 0 }}>
        It is added to this session only, with 3 empty sets. Your program does not change.
      </p>
      <ExerciseList onOpen={onPick} />
    </section>
  );
}
