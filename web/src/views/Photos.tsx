// Progress photos (SPEC §8): add from camera or library with a pose, gallery by date, pose filter,
// side-by-side compare with the day gap and an optional overlay slider, two-step delete.

import { useEffect, useState } from "preact/hooks";
import { faNum } from "../../../worker/lib/digits";
import { daysBetween } from "../../../worker/lib/time";
import type { Photo, Pose } from "../../../worker/lib/types";
import { greg, jalali } from "../format";
import { addPhoto, deletePhoto, loadPhotos, photoSrc, today, useStore } from "../store";

export const POSES: [Pose, string][] = [
  ["front", "جلو"],
  ["side", "بغل"],
  ["back", "پشت"],
  ["other", "دیگر"],
];
export const poseFa = (p: Pose) => POSES.find(([k]) => k === p)?.[1] ?? p;

/** Camera + library pickers for one pose. Used by the gallery and the post-session prompt. */
export function PhotoPicker({ pose, date, sessionId, onDone, compact }: { pose: Pose; date: string; sessionId: string | null; onDone?: (n: number) => void; compact?: boolean }) {
  const [state, setStatus] = useState("");
  const handle = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    let ok = 0;
    for (const [i, f] of list.entries()) {
      setStatus(`در حال آماده‌سازی عکس ${faNum(i + 1)} از ${faNum(list.length)}…`);
      try {
        await addPhoto(f, pose, date, sessionId);
        ok++;
      } catch {
        setStatus("این فایل خوانده نشد. یک عکس JPG، HEIC یا PNG انتخاب کن.");
        return;
      }
    }
    setStatus(ok > 1 ? `${faNum(ok)} عکس ذخیره شد و در صف آپلود است.` : "عکس ذخیره شد و در صف آپلود است.");
    onDone?.(ok);
  };
  return (
    <div class="stack">
      <div class="row picker">
        <label class={`btn ${compact ? "btn-ghost btn-small" : "btn-primary"}`}>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            data-testid={`camera-${pose}`}
            onChange={(e) => {
              const el = e.currentTarget as HTMLInputElement;
              void handle(el.files).finally(() => (el.value = ""));
            }}
          />
          دوربین{compact ? ` · ${poseFa(pose)}` : ""}
        </label>
        {compact ? null : (
          <label class="btn btn-ghost">
            <input
              type="file"
              accept="image/*"
              multiple
              data-testid={`library-${pose}`}
              onChange={(e) => {
                const el = e.currentTarget as HTMLInputElement;
                void handle(el.files).finally(() => (el.value = ""));
              }}
            />
            از گالری
          </label>
        )}
      </div>
      {state ? (
        <div class="why" role="status">
          {state}
        </div>
      ) : null}
    </div>
  );
}

function Compare({ a, b }: { a: Photo; b: Photo }) {
  const [overlay, setOverlay] = useState(false);
  const [pos, setPos] = useState(50);
  const [first, second] = [a, b].sort((x, y) => (x.local_date + x.created_at).localeCompare(y.local_date + y.created_at));
  const gap = daysBetween(first.local_date, second.local_date);
  const cap = (p: Photo) => (
    <figcaption>
      {jalali(p.local_date)}
      <br />
      <span class="ltr">{greg(p.local_date)}</span> · {poseFa(p.pose)}
    </figcaption>
  );
  return (
    <div class="stack" data-testid="compare">
      {overlay ? (
        <div class="overlay">
          <img src={photoSrc(first, "full")} alt="قبل" />
          <img src={photoSrc(second, "full")} alt="بعد" class="top" style={{ clipPath: `inset(0 0 0 ${pos}%)` }} />
          <input type="range" min={0} max={100} value={pos} aria-label="جابه‌جا کردن مرز دو عکس" onInput={(e) => setPos(Number((e.currentTarget as HTMLInputElement).value))} />
        </div>
      ) : (
        <div class="cmp">
          <figure>
            <img src={photoSrc(first, "full")} alt="قبل" />
            {cap(first)}
          </figure>
          <figure>
            <img src={photoSrc(second, "full")} alt="بعد" />
            {cap(second)}
          </figure>
        </div>
      )}
      <div class="kv">
        <span data-testid="gap">فاصله: {faNum(gap)} روز</span>
        <button type="button" class="linkbtn" onClick={() => setOverlay(!overlay)}>
          {overlay ? "کنار هم" : "روی هم (اسلایدر)"}
        </button>
      </div>
    </div>
  );
}

function Viewer({ p, onClose }: { p: Photo; onClose: () => void }) {
  const [armed, setArmed] = useState(false);
  const pending = useStore((s) => Boolean(s.pendingPhotos[p.id]));
  return (
    <div class="card stack" data-testid="viewer">
      <img class="full" src={photoSrc(p, "full")} alt={`عکس ${poseFa(p.pose)} ${jalali(p.local_date)}`} />
      <div class="kv">
        <span>
          {jalali(p.local_date)} · <span class="ltr">{greg(p.local_date)}</span> · {poseFa(p.pose)} {pending ? <span class="pill">در صف آپلود</span> : null}
        </span>
      </div>
      <div class="row">
        <button type="button" class="btn btn-ghost" onClick={onClose}>
          بستن
        </button>
        <button
          type="button"
          class="btn btn-danger"
          onClick={() => {
            if (!armed) return setArmed(true);
            void deletePhoto(p.id);
            onClose();
          }}
        >
          {armed ? "مطمئنی؟ حذف کن" : "حذف عکس"}
        </button>
      </div>
    </div>
  );
}

export function Photos() {
  const photos = useStore((s) => s.photos);
  const pendingIds = useStore((s) => s.pendingPhotos);
  const [pose, setPose] = useState<Pose>("front");
  const [filter, setFilter] = useState<Pose | "all">("all");
  const [comparing, setComparing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    void loadPhotos();
  }, []);

  const shown = photos.filter((p) => filter === "all" || p.pose === filter);
  const groups = new Map<string, Photo[]>();
  for (const p of shown) groups.set(p.local_date, [...(groups.get(p.local_date) ?? []), p]);
  const byId = new Map(photos.map((p) => [p.id, p]));
  const pair = picked.map((id) => byId.get(id)).filter((p): p is Photo => Boolean(p));
  const viewing = open ? byId.get(open) : null;

  const tap = (p: Photo) => {
    if (!comparing) return setOpen(p.id);
    setPicked((cur) => (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id].slice(-2)));
  };

  return (
    <>
      <h2>افزودن عکس</h2>
      <div class="card stack">
        <p class="cue" style={{ margin: 0 }}>
          برای مقایسه‌ی دقیق، هر بار در همان نور، همان جا و همان زاویه‌ها عکس بگیر. عکس‌ها روی گوشی کوچک می‌شوند و اطلاعات مکان از آن‌ها پاک می‌شود.
        </p>
        <div class="seg" role="group" aria-label="زاویه‌ی عکس">
          {POSES.map(([k, label]) => (
            <button type="button" aria-pressed={pose === k} onClick={() => setPose(k)}>
              {label}
            </button>
          ))}
        </div>
        <PhotoPicker pose={pose} date={today()} sessionId={null} />
      </div>

      <h2>مقایسه</h2>
      <div class="card stack">
        {comparing ? (
          pair.length === 2 ? (
            <Compare a={pair[0]} b={pair[1]} />
          ) : (
            <div class="why">دو عکس از پایین انتخاب کن تا کنار هم نمایش داده شوند.{pair.length === 1 ? " (یکی انتخاب شده)" : ""}</div>
          )
        ) : null}
        <button
          type="button"
          class="btn btn-ghost btn-block"
          onClick={() => {
            setComparing(!comparing);
            setPicked([]);
            setOpen(null);
          }}
        >
          {comparing ? "پایان مقایسه" : "انتخاب دو عکس برای مقایسه"}
        </button>
      </div>

      {viewing ? <Viewer p={viewing} onClose={() => setOpen(null)} /> : null}

      <h2>عکس‌ها</h2>
      <div class="seg" role="group" aria-label="فیلتر زاویه" style={{ marginBottom: "10px" }}>
        <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          همه
        </button>
        {POSES.map(([k, label]) => (
          <button type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      {!shown.length ? <div class="empty">هنوز عکسی ثبت نشده. بعد از هر جلسه می‌توانی عکس جلو، بغل و پشت بگیری.</div> : null}
      {[...groups].map(([date, list]) => (
        <>
          <h2>
            {jalali(date)} <small class="ltr">{greg(date)}</small>
          </h2>
          <div class="photos" data-testid="photo-group">
            {list.map((p) => (
              <button type="button" class={`ph${picked.includes(p.id) ? " sel" : ""}`} aria-pressed={picked.includes(p.id)} data-testid="photo" onClick={() => tap(p)}>
                <img src={photoSrc(p, "thumb")} alt={`عکس ${poseFa(p.pose)} ${jalali(p.local_date)}`} loading="lazy" />
                <span class="d">
                  {poseFa(p.pose)}
                  {pendingIds[p.id] ? " · در صف" : ""}
                </span>
              </button>
            ))}
          </div>
        </>
      ))}
    </>
  );
}
