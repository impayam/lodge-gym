// Exercise library (SPEC-v2 §7.3, SPEC-v8 §6.05): search, muscle-group chips and more filters, rows with each
// exercise's number, the 3D body picker ("Body"), a detail screen with media, instructions, muscles and your history,
// custom exercises (create, edit, archive, photo), and the same list as a picker for adding an exercise to a session.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CATEGORIES, countsVolume, type Category } from "../../../worker/lib/category";
import { LICENCE_URL } from "../../../worker/lib/librarySources";
import { CANONICAL_MUSCLES } from "../../../worker/lib/muscles";
import { REGION_INFO, type Region } from "../../../worker/lib/regions";
import { bestSet } from "../../../worker/lib/reports";
import type { Exercise, Pattern, SetEntry, WorkoutSession } from "../../../worker/lib/types";
import { ulid } from "../../../worker/lib/ulid";
import { errorText } from "../api";
import { BodyPicker } from "../components/BodyPicker";
import { Pushed } from "../components/Pushed";
import { IconBack, IconBarbell, IconBody, IconCable, IconDumbbell, IconPlay, IconSearch } from "../components/PulseIcons";
import { Select } from "../components/Select";
import { Empty, LoadError, Loading } from "../components/States";
import { TimeChart } from "../components/TimeChart";
import { dateLong, dayMonth, fmtNum, ytLink } from "../format";
import { BIG_THREE } from "../lib/lifts";
import { emphasises, EVIDENCE_LABEL, inGroup, LIBRARY_GROUPS, loggedExerciseIds, regionChipLabel, regionsForGroup, rowFacts, type LibraryGroup, type RowFact } from "../lib/libraryView";
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
const SOURCE_LABEL: Record<Exercise["source"], string> = {
  seed: "Program",
  fedb: "free-exercise-db",
  manual: "Added by hand",
  custom: "Your exercise",
  wger: "wger",
  everkinetic: "everkinetic",
  exercisedb: "ExerciseDB (facts only)",
  liftosaur: "Liftosaur (facts only)",
  exercemus: "exercemus (facts only)",
};
/** Licence ids as people read them. */
const LICENCE_LABEL: Record<string, string> = { Unlicense: "Unlicense", "CC-BY-SA-3.0": "CC BY-SA 3.0", "CC-BY-SA-4.0": "CC BY-SA 4.0", "CC0-1.0": "CC0", "CC-BY-4.0": "CC BY 4.0" };
const licenceLink = (id: string) => LICENCE_URL[id as keyof typeof LICENCE_URL] ?? null;

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

/** "Chest, front delts, triceps": the main muscle, then the others. */
const musclesLine = (ex: Exercise) => [muscleLabel(ex.muscle_primary), ...ex.muscles_secondary.map((m) => muscleLabel(m).toLowerCase())].join(", ");

/**
 * An exercise as a row card (mockup 05): equipment icon, name, muscles, and its number on the right. The icon is violet
 * (data) when the exercise has been logged and grey when it has not (Payam, 2026-10-15).
 */
function ExerciseRow({ ex, fact, onOpen, testId = "library-row" }: { ex: Exercise; fact: RowFact | undefined; onOpen: () => void; testId?: string }) {
  return (
    <button type="button" class="card press ex-row" data-testid={testId} data-id={ex.id} onClick={onOpen}>
      <span class={`well icon-well icon-well--52 ${fact ? "t-violet" : "icon-well--off"}`}>
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
  /** A region chip under the group (SPEC-v11 A4): exercises with it as their main focus. */
  region: string;
  muscle: string;
  equipment: string;
  pattern: string;
  /** Exercises never logged (SPEC-v11 A4). */
  newToMe: boolean;
}

function matches(ex: Exercise, f: Filters, logged: ReadonlySet<string>): boolean {
  if (!inGroup(ex.muscle_primary, f.group)) return false;
  if (f.region && !emphasises(ex.regions ?? [], f.region)) return false;
  if (f.newToMe && logged.has(ex.id)) return false;
  if (f.muscle && ex.muscle_primary !== f.muscle && !ex.muscles_secondary.includes(f.muscle)) return false;
  if (f.equipment && ex.equipment !== f.equipment) return false;
  if (f.pattern && ex.pattern !== f.pattern) return false;
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const name = ex.name_en.toLowerCase();
  return words.every((w) => name.includes(w));
}

const PAGE = 60;
const NO_FILTERS: Filters = { q: "", group: "all", region: "", muscle: "", equipment: "", pattern: "", newToMe: false };

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
  const load = useStore((s) => s.loads.library);
  const sessions = useStore((s) => s.sessions);
  const history = useStore((s) => s.loads.history);
  const facts = useRowFacts();
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [more, setMore] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => {
    void loadLibrary();
  }, []);
  // "New to me" needs every session, not only the last 60 days the phone keeps.
  useEffect(() => {
    if (f.newToMe && !history) void loadAllHistory();
  }, [f.newToMe]);
  const logged = useMemo(() => loggedExerciseIds(Object.values(sessions)), [sessions]);
  const list = useMemo(() => (library ?? []).filter((e) => (archived || !e.archived_at) && matches(e, f, logged)), [library, f, archived, logged]);
  const set = (patch: Partial<Filters>) => {
    setF({ ...f, ...patch });
    setLimit(PAGE);
  };
  const extra = [f.muscle, f.equipment, f.pattern].filter(Boolean).length + (f.newToMe ? 1 : 0) + (archived ? 1 : 0);
  const regions = regionsForGroup(f.group);
  // Mockup 05 names the chip here ("Chest, …"), without repeating a total the page header already shows.
  const count = `${fmtNum(list.length)} ${list.length === 1 ? "exercise" : "exercises"}`;
  const group = LIBRARY_GROUPS.find((g) => g.key === f.group)!;
  const regionName = f.region ? regionChipLabel(f.region as Region, f.group) : "";
  const countLine = f.group !== "all" ? `${group.label}${regionName ? ` (${regionName.toLowerCase()})` : ""}, ${count}` : totalShown && !f.q.trim() && !extra ? "All exercises" : count;
  return (
    <div class="l-col l-gap-12" data-testid={testId}>
      <label class="search-field well">
        <IconSearch />
        <span class="l-sr">Search exercises</span>
        <input class="search-field__input" type="search" placeholder="Search exercises" value={f.q} onInput={(e) => set({ q: (e.currentTarget as HTMLInputElement).value })} />
      </label>
      <div class="chip-wrap" role="group" aria-label="Muscle group">
        {LIBRARY_GROUPS.map((g) => (
          <button type="button" class="clay press chip" aria-pressed={f.group === g.key} data-testid={`group-${g.key}`} onClick={() => set({ group: g.key, region: "" })}>
            {g.label}
          </button>
        ))}
      </div>
      {regions.length ? (
        <div class="chip-wrap" role="group" aria-label={`${group.label} regions`} data-testid="region-chips">
          {regions.map((r) => (
            <button type="button" class="clay press chip" aria-pressed={f.region === r} data-testid={`region-${r}`} onClick={() => set({ region: f.region === r ? "" : r })}>
              {regionChipLabel(r, f.group)}
            </button>
          ))}
        </div>
      ) : null}
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
          {/* One under another: three side by side cut their labels at iPhone width ("All muscl…"). */}
          <div class="l-col l-gap-8">
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
          <div class="chip-wrap">
            <button type="button" class="clay press chip" aria-pressed={f.newToMe} data-testid="new-to-me" onClick={() => set({ newToMe: !f.newToMe })}>
              New to me
            </button>
            {onArchived ? (
              <button type="button" class="clay press chip" aria-pressed={!!archived} data-testid="show-archived" onClick={() => onArchived(!archived)}>
                Show archived exercises
              </button>
            ) : null}
          </div>
          {f.newToMe ? (
            <p class="caption l-m0" data-testid="new-to-me-note">
              {history?.status === "loading" || !history ? "Checking your older sessions…" : history.status === "error" ? "Older sessions couldn't load: only the last 60 days are checked." : "Exercises you have never logged."}
            </p>
          ) : null}
        </div>
      ) : null}
      {library === null && load?.status === "error" ? (
        <LoadError what="Couldn't load the exercise library." error={load.error} onRetry={() => void loadLibrary()} />
      ) : library === null ? (
        <Loading label="Loading the library" />
      ) : (
        <>
          {list.slice(0, limit).map((ex) => (
            <ExerciseRow ex={ex} fact={facts.get(ex.id)} onOpen={() => onOpen(ex)} />
          ))}
          {list.length > limit ? (
            <button type="button" class="clay press btn t-muted" onClick={() => setLimit(limit + PAGE)}>
              Show more
            </button>
          ) : null}
          {!list.length ? (
            <Empty action={f.q.trim() || f.group !== "all" || extra ? { label: "Clear search and filters", onClick: () => set(NO_FILTERS), testId: "library-clear" } : undefined}>
              No exercise matches.
            </Empty>
          ) : null}
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
  const older = useStore((s) => s.loads.history);
  useEffect(() => {
    void loadAllHistory();
  }, []);
  const olderFailed = older?.status === "error" ? <LoadError what="Couldn't load sessions older than 60 days." error={older.error} onRetry={() => void loadAllHistory()} /> : null;
  const withEx = Object.values(sessions)
    .filter((s) => s.sets.some((x) => x.exercise_id === ex.id && x.done))
    .sort((a, b) => (a.local_date + a.started_at).localeCompare(b.local_date + b.started_at));
  if (!withEx.length)
    return (
      <div class="l-col l-gap-12" data-testid="exercise-history">
        {olderFailed ?? (older?.status !== "done" ? <Loading label="Loading your history with this exercise" heights={[140]} /> : <Empty>No sets logged with this exercise yet.</Empty>)}
      </div>
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
      {olderFailed}
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
  const [broken, setBroken] = useState<string[]>([]);
  const shown = images.slice(0, 2).filter((m) => !broken.includes(mediaSrc(m)));
  // Credit the authors of images from open-licence sources (their own licence, SPEC-v11 A1).
  const credits = [...new Set(shown.filter((m) => m.license).map((m) => `${m.author ?? "unknown"}, ${LICENCE_LABEL[m.license!] ?? m.license}`))];
  const regions = ex.regions ?? [];
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
        {shown.length ? (
          <div class="l-col l-gap-8">
            <div class="media-pair">
              {shown.map((m, i) => (
                <span class="media-frame well">
                  <img src={mediaSrc(m)} alt={shown.length === 1 ? ex.name_en : `${ex.name_en}, ${i === 0 ? "start" : "end"} position`} loading="lazy" onError={() => setBroken((b) => [...b, mediaSrc(m)])} />
                </span>
              ))}
            </div>
            {credits.length ? (
              <span class="caption" data-testid="image-credit">
                Image: {credits.join("; ")}
              </span>
            ) : null}
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
        {regions.length ? (
          <section class="card card--list" aria-label="Regions" data-testid="exercise-regions">
            <h2 class="card__title l-m0">Regions</h2>
            {regions.map((r) => (
              <div class="list-row" data-region={r.region} data-emphasis={r.emphasis}>
                <span class="list-row__text">
                  <span class="t-title">{REGION_INFO[r.region].label}</span>
                  <span class="caption">
                    {r.emphasis === "primary" ? "Main focus" : "Also trained"} · {EVIDENCE_LABEL[r.evidence]}
                  </span>
                </span>
              </div>
            ))}
            <span class="caption" data-testid="evidence-note">
              Strong: growth studies or clear anatomy and EMG. Moderate: EMG and biomechanics agree. Weak: anatomy alone or mixed findings.
            </span>
          </section>
        ) : null}
        <section class="card card--list" aria-label="About this exercise">
          <Fact name="Primary muscle" value={muscleLabel(ex.muscle_primary)} />
          <Fact name="Secondary muscles" value={ex.muscles_secondary.length ? ex.muscles_secondary.map(muscleLabel).join(", ") : "–"} />
          <Fact name="Equipment" value={equipmentLabel(ex.equipment)} />
          <Fact name="Pattern" value={ex.pattern ? PATTERN_LABEL[ex.pattern] : "–"} />
          <Fact name="Category" value={ex.category ? CATEGORY_LABEL[ex.category] : "–"} testid="category" />
          <Fact name="Mechanic · level" value={`${ex.mechanic ?? "–"} · ${ex.level ?? "–"}`} />
          <Fact name="Source" value={SOURCE_LABEL[ex.source] ?? ex.source} testid="source" />
          {ex.license ? (
            <div class="list-row" data-testid="licence">
              <span class="list-row__text">
                <span class="caption">Licence</span>
              </span>
              <span class="list-row__value">
                {licenceLink(ex.license) ? (
                  <a class="t-pink" href={licenceLink(ex.license)!} target="_blank" rel="noopener noreferrer">
                    {LICENCE_LABEL[ex.license] ?? ex.license}
                  </a>
                ) : (
                  (LICENCE_LABEL[ex.license] ?? ex.license)
                )}
                {ex.license_author ? ` · ${ex.license_author}` : ""}
              </span>
            </div>
          ) : null}
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
