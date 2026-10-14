// Exercise library (SPEC-v2 §7.3, SPEC-v8 §6.05): search, muscle-group chips and more filters, rows with each
// exercise's number, the 3D body picker ("Body"), a detail screen with media, instructions, muscles and your history,
// custom exercises (create, edit, archive, photo), and the same list as a picker for adding an exercise to a session.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CATEGORIES, countsVolume, type Category } from "../../../worker/lib/category";
import { CANONICAL_MUSCLES } from "../../../worker/lib/muscles";
import { bestSet } from "../../../worker/lib/reports";
import type { Exercise, Pattern, SetEntry, WorkoutSession } from "../../../worker/lib/types";
import { ulid } from "../../../worker/lib/ulid";
import { errorText } from "../api";
import { BodyPicker } from "../components/BodyPicker";
import { Pushed } from "../components/Pushed";
import { IconBack, IconBarbell, IconBody, IconCable, IconDumbbell, IconPlay, IconSearch } from "../components/PulseIcons";
import { Select } from "../components/Select";
import { TimeChart } from "../components/TimeChart";
import { dateLong, dayMonth, fmtNum, ytLink } from "../format";
import { BIG_THREE } from "../lib/lifts";
import { inGroup, LIBRARY_GROUPS, rowFacts, type LibraryGroup, type RowFact } from "../lib/libraryView";
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

const EQUIPMENT_ICON: Record<Exercise["equipment"], (p: { size?: number }) => preact.JSX.Element> = {
  barbell: IconBarbell,
  bodyweight: IconBarbell,
  dumbbell: IconDumbbell,
  cable: IconCable,
  machine: IconCable,
};
/** The equipment icon of an exercise row. */
export function EquipmentIcon({ equipment, size = 26 }: { equipment: Exercise["equipment"]; size?: number }) {
  const Icon = EQUIPMENT_ICON[equipment] ?? IconBarbell;
  return <Icon size={size} />;
}

/** Logged rows take the accents in turn (mockup 05); a row not logged yet stays grey. */
const ROW_TINT = ["t-pink", "t-violet", "t-orange"];

/** "Chest, front delts, triceps": the main muscle, then the others. */
const musclesLine = (ex: Exercise) => [muscleLabel(ex.muscle_primary), ...ex.muscles_secondary.map((m) => muscleLabel(m).toLowerCase())].join(", ");

/** An exercise as a row card (mockup 05): equipment icon, name, muscles, and its number on the right. */
function ExerciseRow({ ex, fact, i, onOpen, testId = "library-row" }: { ex: Exercise; fact: RowFact | undefined; i: number; onOpen: () => void; testId?: string }) {
  return (
    <button type="button" class="card press ex-row" data-testid={testId} data-id={ex.id} onClick={onOpen}>
      <span class={`well icon-well icon-well--52 ${fact ? ROW_TINT[i % ROW_TINT.length] : "icon-well--off"}`}>
        <EquipmentIcon equipment={ex.equipment} />
      </span>
      <span class="list-row__text">
        <b class="t-title">{ex.name_en}</b>
        <span class="caption">
          {musclesLine(ex)}
          {ex.archived_at ? " · archived" : ""}
          <span class="l-sr">, {equipmentLabel(ex.equipment)}</span>
        </span>
      </span>
      <span class="ex-row__side">
        <span class="big-num big-num--22 num">{fact ? fmtNum(fact.value) : "—"}</span>
        <span class="caption">{fact ? fact.label : "not logged"}</span>
      </span>
    </button>
  );
}

function useRowFacts() {
  const sessions = useStore((s) => s.sessions);
  const unit = useStore((s) => s.boot!.settings.unit);
  return useMemo(() => rowFacts(Object.values(sessions), unit, new Set(BIG_THREE.map((l) => l.id))), [sessions, unit]);
}

interface Filters {
  q: string;
  group: LibraryGroup;
  muscle: string;
  equipment: string;
  pattern: string;
}

function matches(ex: Exercise, f: Filters): boolean {
  if (!inGroup(ex.muscle_primary, f.group)) return false;
  if (f.muscle && ex.muscle_primary !== f.muscle && !ex.muscles_secondary.includes(f.muscle)) return false;
  if (f.equipment && ex.equipment !== f.equipment) return false;
  if (f.pattern && ex.pattern !== f.pattern) return false;
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const name = ex.name_en.toLowerCase();
  return words.every((w) => name.includes(w));
}

const PAGE = 60;

/**
 * The searchable exercise list (mockup 05): search, muscle-group chips, the count, more filters (muscle, equipment,
 * pattern, and archived exercises in the Library tab), then the rows. Used by the Library tab and the picker's Search.
 */
export function ExerciseList({
  onOpen,
  archived,
  onArchived,
  totalShown,
  testId,
}: {
  onOpen: (ex: Exercise) => void;
  archived?: boolean;
  onArchived?: (on: boolean) => void;
  /** The page header already shows the library's total. */
  totalShown?: boolean;
  testId?: string;
}) {
  const library = useStore((s) => s.library);
  const facts = useRowFacts();
  const [f, setF] = useState<Filters>({ q: "", group: "all", muscle: "", equipment: "", pattern: "" });
  const [more, setMore] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => {
    void loadLibrary();
  }, []);
  const list = useMemo(() => (library ?? []).filter((e) => (archived || !e.archived_at) && matches(e, f)), [library, f, archived]);
  const set = (patch: Partial<Filters>) => {
    setF({ ...f, ...patch });
    setLimit(PAGE);
  };
  const extra = [f.muscle, f.equipment, f.pattern].filter(Boolean).length + (archived ? 1 : 0);
  // Mockup 05 names the chip here ("Chest, …"), without repeating a total the page header already shows.
  const count = `${fmtNum(list.length)} ${list.length === 1 ? "exercise" : "exercises"}`;
  const group = LIBRARY_GROUPS.find((g) => g.key === f.group)!;
  const countLine = f.group !== "all" ? `${group.label}, ${count}` : totalShown && !f.q.trim() && !extra ? "All exercises" : count;
  return (
    <div class="l-col l-gap-12" data-testid={testId}>
      <label class="search-field well">
        <IconSearch />
        <span class="l-sr">Search exercises</span>
        <input class="search-field__input" type="search" placeholder="Search exercises" value={f.q} onInput={(e) => set({ q: (e.currentTarget as HTMLInputElement).value })} />
      </label>
      <div class="chip-wrap" role="group" aria-label="Muscle group">
        {LIBRARY_GROUPS.map((g) => (
          <button type="button" class="clay press chip" aria-pressed={f.group === g.key} data-testid={`group-${g.key}`} onClick={() => set({ group: g.key })}>
            {g.label}
          </button>
        ))}
      </div>
      <div class="l-row l-between l-gap-8">
        <span class="caption num" data-testid="library-count" aria-live="polite">
          {library === null ? "" : countLine}
        </span>
        <button type="button" class="clay press btn-sm t-muted" aria-expanded={more} aria-controls={`${testId ?? "list"}-filters`} data-testid="library-filters" onClick={() => setMore(!more)}>
          {extra ? `Filters (${fmtNum(extra)})` : "Filters"}
        </button>
      </div>
      {more ? (
        <div id={`${testId ?? "list"}-filters`} class="l-col l-gap-8">
          <div class="l-grid-3 l-gap-8">
            <Select aria-label="Muscle" value={f.muscle} onChange={(e) => set({ muscle: (e.currentTarget as HTMLSelectElement).value })}>
              <option value="">All muscles</option>
              {CANONICAL_MUSCLES.map((m) => (
                <option value={m}>{muscleLabel(m)}</option>
              ))}
            </Select>
            <Select aria-label="Equipment" value={f.equipment} onChange={(e) => set({ equipment: (e.currentTarget as HTMLSelectElement).value })}>
              <option value="">All equipment</option>
              {EQUIPMENT.map(([k, label]) => (
                <option value={k}>{label}</option>
              ))}
            </Select>
            <Select aria-label="Pattern" value={f.pattern} onChange={(e) => set({ pattern: (e.currentTarget as HTMLSelectElement).value })}>
              <option value="">All patterns</option>
              {(Object.keys(PATTERN_LABEL) as Pattern[]).map((p) => (
                <option value={p}>{PATTERN_LABEL[p]}</option>
              ))}
            </Select>
          </div>
          {onArchived ? (
            <div class="l-row">
              <button type="button" class="clay press chip" aria-pressed={!!archived} data-testid="show-archived" onClick={() => onArchived(!archived)}>
                Show archived exercises
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {library === null ? (
        <div class="l-col l-gap-8" aria-label="Loading the library">
          <span class="skeleton" style={{ height: "76px" }} />
          <span class="skeleton" style={{ height: "76px" }} />
        </div>
      ) : (
        <>
          {list.slice(0, limit).map((ex, i) => (
            <ExerciseRow ex={ex} fact={facts.get(ex.id)} i={i} onOpen={() => onOpen(ex)} />
          ))}
          {list.length > limit ? (
            <button type="button" class="clay press btn t-muted" onClick={() => setLimit(limit + PAGE)}>
              Show more
            </button>
          ) : null}
          {!list.length ? <p class="state l-m0">No exercise matches.</p> : null}
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
      <p class="state l-m0" data-testid="exercise-history">
        No sets logged with this exercise yet.
      </p>
    );
  const last: WorkoutSession = withEx[withEx.length - 1];
  const lastSets = last.sets.filter((x) => x.exercise_id === ex.id && x.done).sort((a, b) => a.set_index - b.set_index);
  const points = withEx.map((s) => ({ date: s.local_date, best: bestSet(s, ex.id, unit) })).filter((p) => p.best);
  const best = points.reduce<(typeof points)[number] | null>((b, p) => (!b || p.best!.e1rm > b.best!.e1rm ? p : b), null);
  return (
    <div class="l-col l-gap-12" data-testid="exercise-history">
      <div class="card--list">
        <div class="list-row">
          <span class="list-row__text">
            <span class="t-title">Last time</span>
            <span class="caption num">{dateLong(last.local_date)}</span>
          </span>
          <span class="list-row__value num">{lastSets.map((x) => setLine(x, last.unit)).join(", ")}</span>
        </div>
        <div class="list-row">
          <span class="list-row__text">
            <span class="t-title">Best estimated 1RM</span>
          </span>
          <span class="list-row__value num" data-testid="best-e1rm">
            {best ? `${fmtNum(best.best!.e1rm, 1)} ${unit} (${fmtNum(best.best!.weight, 1)}×${fmtNum(best.best!.reps)}, ${dayMonth(best.date)})` : "–"}
          </span>
        </div>
        <div class="list-row">
          <span class="list-row__text">
            <span class="t-title">Sessions</span>
          </span>
          <span class="list-row__value num">{fmtNum(withEx.length)}</span>
        </div>
      </div>
      {points.length ? (
        <TimeChart
          series={[{ label: "Best set, estimated 1RM", color: "--series-2", points: points.map((p) => ({ date: p.date, value: p.best!.e1rm })) }]}
          height={120}
          yAxis
          label={`${ex.name_en}: estimated 1RM of the best set per session, ${unit}`}
          unit={unit}
        />
      ) : null}
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
    <main class="page" data-testid="custom-form">
      <header class="screen-head">
        <button type="button" class="clay press btn-icon t-muted" aria-label="Cancel" disabled={busy} onClick={onCancel}>
          <IconBack size={20} />
        </button>
        <h1 class="screen-head__title l-m0 l-grow">{initial ? "Edit exercise" : "New custom exercise"}</h1>
      </header>
      <section class="card l-col l-gap-12">
        <div class="form-field">
          <label class="form-field__label" for="cx-name">
            Name
          </label>
          <input id="cx-name" class="input" value={name} maxLength={80} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        </div>
        <div class="form-field">
          <label class="form-field__label" for="cx-primary">
            Primary muscle
          </label>
          <Select id="cx-primary" value={primary} onChange={(e) => setPrimary((e.currentTarget as HTMLSelectElement).value)}>
            {CANONICAL_MUSCLES.map((m) => (
              <option value={m}>{muscleLabel(m)}</option>
            ))}
          </Select>
        </div>
        <fieldset class="form-field">
          <legend class="form-field__label">Secondary muscles</legend>
          <div class="chip-wrap">
            {CANONICAL_MUSCLES.filter((m) => m !== primary).map((m) => (
              <label class="check-chip">
                <input
                  type="checkbox"
                  checked={secondary.includes(m)}
                  onChange={(e) => setSecondary((e.currentTarget as HTMLInputElement).checked ? [...secondary, m] : secondary.filter((x) => x !== m))}
                />
                {muscleLabel(m)}
              </label>
            ))}
          </div>
        </fieldset>
        <div class="l-grid-2 l-gap-8">
          <div class="form-field">
            <label class="form-field__label" for="cx-eq">
              Equipment
            </label>
            <Select id="cx-eq" value={equipment} onChange={(e) => setEquipment((e.currentTarget as HTMLSelectElement).value as Exercise["equipment"])}>
              {EQUIPMENT.map(([k, label]) => (
                <option value={k}>{label}</option>
              ))}
            </Select>
          </div>
          <div class="form-field">
            <label class="form-field__label" for="cx-pattern">
              Pattern
            </label>
            <Select id="cx-pattern" value={pattern} onChange={(e) => setPattern((e.currentTarget as HTMLSelectElement).value as Pattern | "")}>
              <option value="">None</option>
              {(Object.keys(PATTERN_LABEL) as Pattern[]).map((p) => (
                <option value={p}>{PATTERN_LABEL[p]}</option>
              ))}
            </Select>
          </div>
        </div>
        <div class="form-field">
          <label class="form-field__label" for="cx-category">
            Category
          </label>
          <Select id="cx-category" value={category} onChange={(e) => setCategory((e.currentTarget as HTMLSelectElement).value as Category)}>
            {CATEGORIES.map((k) => (
              <option value={k}>{CATEGORY_LABEL[k]}</option>
            ))}
          </Select>
        </div>
        <div class="form-field">
          <span class="form-field__label" id="cx-photo-label">
            Photo (optional)
          </span>
          <div class="l-row l-gap-12">
            <label class="clay press btn btn--fit t-muted file-pick">
              <input type="file" accept="image/*" aria-labelledby="cx-photo-label" onChange={(e) => setPhoto((e.currentTarget as HTMLInputElement).files?.[0] ?? null)} />
              {photo || initial?.media.length ? "Change photo" : "Choose photo"}
            </label>
            <span class="list-row__note l-grow" aria-live="polite">
              {photo ? photo.name : initial?.media.length ? "Keeps the current photo." : "No photo."}
            </span>
          </div>
        </div>
      </section>
      <div class="l-row l-gap-8">
        <button type="button" class="clay press btn-lg t-pink l-grow" disabled={busy || !name.trim()} onClick={() => void save()}>
          Save
        </button>
        <button type="button" class="clay press btn-lg btn--fit t-muted" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {err ? (
        <p class="caption t-orange l-m0" role="alert">
          {err}
        </p>
      ) : null}
    </main>
  );
}

function Fact({ name, value, testid }: { name: string; value: string; testid?: string }) {
  return (
    <div class="list-row">
      <span class="list-row__text">
        <span class="caption">{name}</span>
      </span>
      <span class="list-row__value" data-testid={testid}>
        {value}
      </span>
    </div>
  );
}

function ExerciseDetail({ ex, onBack, onEdit }: { ex: Exercise; onBack: () => void; onEdit: () => void }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const archive = async (archived: boolean) => {
    setBusy(true);
    setErr("");
    try {
      await saveCustomExercise(ex.id, {
        name_en: ex.name_en,
        muscle_primary: ex.muscle_primary,
        muscles_secondary: ex.muscles_secondary,
        equipment: ex.equipment,
        pattern: ex.pattern,
        category: ex.category ?? undefined,
        archived,
      });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const images = ex.media.filter((m) => m.kind === "image" || m.kind === "gif");
  return (
    <Pushed onBack={onBack}>
      <main class="page" data-testid="exercise-detail">
        <header class="screen-head">
          <button type="button" class="clay press btn-icon t-muted" aria-label="Back to the library" onClick={onBack}>
            <IconBack size={20} />
          </button>
          <div class="l-col l-grow">
            <span class="screen-head__sub">Library</span>
            <h1 class="screen-head__title l-m0">{ex.name_en}</h1>
          </div>
        </header>
        {/* A missing category only comes from a copy cached before the category existed: say nothing rather than guess. */}
        {!ex.category || countsVolume(ex.category) ? null : (
          <p class="callout l-m0 ex-card__meta" data-testid="not-counted">
            <b class="t-orange">Not counted in volume</b> Sets are logged, but count 0 toward weekly muscle volume and the muscle map.
          </p>
        )}
        {images.length ? (
          <div class="media-pair">
            {images.slice(0, 2).map((m, i) => (
              <span class="media-frame well">
                <img src={mediaSrc(m)} alt={`${ex.name_en}, ${i === 0 ? "start" : "end"} position`} loading="lazy" />
              </span>
            ))}
          </div>
        ) : (
          <p class="state card l-m0" data-testid="media-placeholder">
            No image
          </p>
        )}
        <a class="clay press btn t-orange l-row l-center l-gap-8" href={ytLink(ex.name_en)} target="_blank" rel="noopener noreferrer">
          <IconPlay size={16} />
          Watch form video ↗
        </a>
        <section class="card card--list" aria-label="About this exercise">
          <Fact name="Primary muscle" value={muscleLabel(ex.muscle_primary)} />
          <Fact name="Secondary muscles" value={ex.muscles_secondary.length ? ex.muscles_secondary.map(muscleLabel).join(", ") : "–"} />
          <Fact name="Equipment" value={equipmentLabel(ex.equipment)} />
          <Fact name="Pattern" value={ex.pattern ? PATTERN_LABEL[ex.pattern] : "–"} />
          <Fact name="Category" value={ex.category ? CATEGORY_LABEL[ex.category] : "–"} testid="category" />
          <Fact name="Mechanic · level" value={`${ex.mechanic ?? "–"} · ${ex.level ?? "–"}`} />
          <Fact name="Source" value={SOURCE_LABEL[ex.source]} />
        </section>
        {ex.cue_en ? <p class="ex-card__cue l-m0">{ex.cue_en}</p> : null}
        {ex.instructions_en.length ? (
          <section class="card l-col l-gap-12">
            <h2 class="card__title l-m0">Instructions</h2>
            <ol class="prose-list">
              {ex.instructions_en.map((s) => (
                <li>{s}</li>
              ))}
            </ol>
          </section>
        ) : null}
        <section class="card l-col l-gap-12">
          <h2 class="card__title l-m0">Your history</h2>
          <ExerciseHistory ex={ex} />
        </section>
        {ex.source === "custom" ? (
          <div class="l-row l-gap-8">
            <button type="button" class="clay press btn btn--fit t-muted l-grow" disabled={busy} onClick={onEdit}>
              Edit
            </button>
            <button type="button" class="clay press btn btn--fit t-muted l-grow" disabled={busy} data-testid="archive" onClick={() => void archive(!ex.archived_at)}>
              {ex.archived_at ? "Restore" : "Archive"}
            </button>
          </div>
        ) : null}
        {err ? (
          <p class="caption t-orange l-m0" role="alert">
            {err}
          </p>
        ) : null}
      </main>
    </Pushed>
  );
}

export function Library() {
  const library = useStore((s) => s.library);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ edit: Exercise | null } | null>(null);
  const [body, setBody] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const open = openId ? (library ?? []).find((e) => e.id === openId) : null;
  // A detail, the form or the body picker opens at the top; back on the list, the list is where it was.
  const listY = useRef(0);
  const away = !!(openId || form || body);
  useEffect(() => {
    if (away) window.scrollTo(0, 0);
    else requestAnimationFrame(() => window.scrollTo(0, listY.current));
  }, [away, openId, form, body]);
  const leaveList = () => {
    if (!away) listY.current = window.scrollY;
  };
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
  if (body)
    return (
      <Pushed onBack={() => setBody(false)}>
        <main class="page" data-testid="library-body">
          <header class="screen-head">
            <button type="button" class="clay press btn-icon t-muted" aria-label="Back to the library" onClick={() => setBody(false)}>
              <IconBack size={20} />
            </button>
            <h1 class="screen-head__title l-m0 l-grow">Pick by body part</h1>
          </header>
          <BodyPicker
            sessionId="library"
            onPick={(ex) => {
              setBody(false);
              setOpenId(ex.id);
            }}
          />
        </main>
      </Pushed>
    );
  const total = (library ?? []).filter((e) => !e.archived_at).length;
  return (
    <main class="page" data-testid="library-tab">
      <header class="page-head">
        <div class="l-col l-gap-2">
          <span class="page-head__sub num">{library === null ? "Library" : `${fmtNum(total)} exercises`}</span>
          <h1 class="h-page">Library</h1>
        </div>
        <button
          type="button"
          class="clay press btn t-pink l-row l-gap-8"
          aria-label="Pick by body part"
          data-testid="open-body"
          onClick={() => {
            leaveList();
            setBody(true);
          }}
        >
          <IconBody size={18} />
          Body
        </button>
      </header>
      <ExerciseList
        onOpen={(ex) => {
          leaveList();
          setOpenId(ex.id);
        }}
        archived={showArchived}
        onArchived={setShowArchived}
        totalShown
        testId="library"
      />
      <button
        type="button"
        class="clay press btn t-pink"
        data-testid="new-custom"
        onClick={() => {
          leaveList();
          setForm({ edit: null });
        }}
      >
        + Custom exercise
      </button>
    </main>
  );
}

/** Which tab "+ Add exercise" opened on last, per session (Body by default, SPEC-v3 M9b). */
const pickerTab = new Map<string, "body" | "search">();

/**
 * "+ Add exercise" in a session, and Add / Replace in the session planner (SPEC-v3 M9c): the body map (default) or
 * search, full screen.
 * @param sessionId keys the remembered tab and body-picker place (a session or a plan id).
 */
export function ExercisePicker({
  sessionId,
  onPick,
  onCancel,
  title = "Add an exercise",
  note = "It is added to this session only, with 3 empty sets. Your program does not change.",
}: {
  sessionId: string;
  onPick: (ex: Exercise) => void;
  onCancel: () => void;
  title?: string;
  note?: string;
}) {
  const [tab, setTab] = useState<"body" | "search">(() => pickerTab.get(sessionId) ?? "body");
  const choose = (t: "body" | "search") => {
    pickerTab.set(sessionId, t);
    setTab(t);
  };
  // The picker replaces the page it was opened from, which may be scrolled down: start it at the top.
  useEffect(() => window.scrollTo(0, 0), []);
  return (
    <main class="page" data-testid="exercise-picker">
      <header class="screen-head">
        <h1 class="screen-head__title l-m0 l-grow">{title}</h1>
        <button type="button" class="clay press btn t-muted" onClick={onCancel}>
          Cancel
        </button>
      </header>
      <span class="segmented l-full" role="tablist" aria-label="Find an exercise by">
        {(
          [
            ["body", "Body"],
            ["search", "Search"],
          ] as const
        ).map(([k, label]) => (
          <button type="button" class="press l-grow" role="tab" aria-selected={tab === k} data-testid={`picker-tab-${k}`} onClick={() => choose(k)}>
            {label}
          </button>
        ))}
      </span>
      <p class="caption l-m0">{note}</p>
      {tab === "body" ? <BodyPicker sessionId={sessionId} onPick={onPick} /> : <ExerciseList onOpen={onPick} testId="picker-list" />}
    </main>
  );
}
