// Progress photos (SPEC §8): add from the in-app guide camera (SPEC-v10.1) or the library with a pose, gallery by date,
// pose filter, side-by-side compare with the day gap and an optional overlay slider, two-step delete.

import { useEffect, useState } from "preact/hooks";
import { daysBetween } from "../../../worker/lib/time";
import { FRAMING_LABEL } from "../../../worker/lib/photoGroups";
import type { Photo, Pose } from "../../../worker/lib/types";
import { dateLong, dateShort, fmtNum } from "../format";
import { IconCamera } from "../components/PulseIcons";
import { ScreenHead } from "../components/ScreenHead";
import { SyncStatus } from "../components/SyncStatus";
import { Empty, isOffline, LoadError, Loading } from "../components/States";
import { GuideCamera } from "../components/GuideCamera";
import { addPhoto, deletePhoto, loadPhotos, photoSrc, today, useStore } from "../store";

export const POSES: [Pose, string][] = [
  ["front", "Front"],
  ["side", "Side"],
  ["back", "Back"],
  ["other", "Other"],
];
export const poseLabel = (p: Pose) => POSES.find(([k]) => k === p)?.[1] ?? p;
/** "Front · Upper body"; the pose alone when the framing is not known (library and older photos). */
export const photoLabel = (p: Photo) => `${poseLabel(p.pose)}${p.framing ? ` · ${FRAMING_LABEL[p.framing]}` : ""}`;

/** Camera + library pickers for one pose. Used by the gallery and the post-session prompt. */
export function PhotoPicker({ pose, date, sessionId, onDone, compact, startCamera }: { pose: Pose; date: string; sessionId: string | null; onDone?: (n: number) => void; compact?: boolean; startCamera?: boolean }) {
  const [state, setStatus] = useState("");
  const [camera, setCamera] = useState(!!startCamera);
  const handle = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    let ok = 0;
    for (const [i, f] of list.entries()) {
      setStatus(`Preparing photo ${i + 1} of ${list.length}…`);
      try {
        await addPhoto(f, pose, date, sessionId);
        ok++;
      } catch {
        setStatus("This file could not be read. Pick a JPG, HEIC or PNG photo.");
        return;
      }
    }
    setStatus(ok > 1 ? `${fmtNum(ok)} photos saved and queued for upload.` : "Photo saved and queued for upload.");
    onDone?.(ok);
  };
  const status = state ? (
    <span class="caption" role="status">
      {state}
    </span>
  ) : null;
  // The in-app guide camera (SPEC-v10.1) for the pose; in the gallery the photo library too.
  const cameraButton = (
    <>
      <button type="button" class={`clay press btn btn--fit l-gap-8 ${compact ? "t-muted" : "t-pink"}`} data-testid={`camera-${pose}`} onClick={() => setCamera(true)}>
        <IconCamera size={18} />
        {compact ? (
          <>
            <span class="l-sr">Camera, </span>
            {poseLabel(pose)}
          </>
        ) : (
          "Camera"
        )}
      </button>
      <GuideCamera
        open={camera}
        onClose={() => setCamera(false)}
        date={date}
        sessionId={sessionId}
        pose={pose}
        onSaved={() => {
          setStatus("Photo saved and queued for upload.");
          onDone?.(1);
        }}
      />
    </>
  );
  if (compact)
    return (
      <div class="l-row l-gap-12">
        {cameraButton}
        {status}
      </div>
    );
  return (
    <div class="l-col l-gap-8">
      <div class="l-row l-gap-8">
        {cameraButton}
        <label class="clay press btn btn--fit file-pick t-muted">
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
          From library
        </label>
      </div>
      {status}
    </div>
  );
}

function Compare({ a, b }: { a: Photo; b: Photo }) {
  const [overlay, setOverlay] = useState(false);
  const [pos, setPos] = useState(50);
  const [first, second] = [a, b].sort((x, y) => (x.local_date + x.created_at).localeCompare(y.local_date + y.created_at));
  const gap = daysBetween(first.local_date, second.local_date);
  const figure = (p: Photo, alt: string) => (
    <figure class="photo-thumb l-m0">
      <span class="photo-thumb__frame well">
        <img src={photoSrc(p, "full")} alt={alt} />
      </span>
      <figcaption class="caption num">
        {dateShort(p.local_date)} · {photoLabel(p)}
      </figcaption>
    </figure>
  );
  return (
    <div class="l-col l-gap-10" data-testid="compare">
      {overlay ? (
        <div class="l-col l-gap-4">
          <div class="photo-overlay well">
            <img src={photoSrc(first, "full")} alt="Before" />
            <img src={photoSrc(second, "full")} alt="After" style={{ clipPath: `inset(0 0 0 ${pos}%)` }} />
          </div>
          <input class="range" type="range" min={0} max={100} value={pos} aria-label="Move the divider between the two photos" onInput={(e) => setPos(Number((e.currentTarget as HTMLInputElement).value))} />
          <span class="l-row l-between caption num">
            <span>Before: {dateShort(first.local_date)}</span>
            <span>After: {dateShort(second.local_date)}</span>
          </span>
        </div>
      ) : (
        <div class="l-grid-2 l-gap-8">
          {figure(first, "Before")}
          {figure(second, "After")}
        </div>
      )}
      <div class="l-row l-between l-gap-8">
        <span class="ex-card__meta num" data-testid="gap">
          Gap: {fmtNum(gap)} {gap === 1 ? "day" : "days"}
        </span>
        <button type="button" class="clay press btn-sm btn--fit t-muted" onClick={() => setOverlay(!overlay)}>
          {overlay ? "Side by side" : "Overlay (slider)"}
        </button>
      </div>
    </div>
  );
}

function Viewer({ p, onClose }: { p: Photo; onClose: () => void }) {
  const [armed, setArmed] = useState(false);
  const pending = useStore((s) => Boolean(s.pendingPhotos[p.id]));
  return (
    <section class="card l-col l-gap-10" data-testid="viewer" aria-label="Photo">
      <img class="photo-full" src={photoSrc(p, "full")} alt={`${photoLabel(p)} photo, ${dateLong(p.local_date)}`} />
      <span class="ex-card__meta num">
        {dateLong(p.local_date)} · {photoLabel(p)} {pending ? <span class="badge">queued for upload</span> : null}
      </span>
      <div class="l-row l-gap-8">
        <button type="button" class="clay press btn t-muted l-grow" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          class="clay press btn t-danger l-grow"
          onClick={() => {
            if (!armed) return setArmed(true);
            void deletePhoto(p.id);
            onClose();
          }}
        >
          {armed ? "Sure? Delete" : "Delete photo"}
        </button>
      </div>
    </section>
  );
}

/** `compare` starts in compare mode; `open` starts with that photo open (both from Profile). */
export function Photos({ compare = false, open: openFirst }: { compare?: boolean; open?: string }) {
  const photos = useStore((s) => s.photos);
  const pendingIds = useStore((s) => s.pendingPhotos);
  const [pose, setPose] = useState<Pose>("front");
  const [filter, setFilter] = useState<Pose | "all">("all");
  const [comparing, setComparing] = useState(compare);
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(openFirst ?? null);
  const load = useStore((s) => s.loads.photos);
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
    <main class="page" data-testid="photos">
      <ScreenHead title="Progress photos" sub="Profile">
        {/* New photos wait in the queue until they upload. */}
        <SyncStatus />
      </ScreenHead>
      <section class="card l-col l-gap-12" aria-labelledby="photos-add">
        <div class="l-col l-gap-4">
          <h2 class="card__title l-m0" id="photos-add">
            Add photos
          </h2>
          <span class="caption">For a fair comparison, take each photo in the same light, place and angles. Photos are resized on the phone and their location data is removed.</span>
        </div>
        <span class="segmented l-full" role="group" aria-label="Photo pose">
          {POSES.map(([k, label]) => (
            <button type="button" class="press l-grow" aria-pressed={pose === k} onClick={() => setPose(k)}>
              {label}
            </button>
          ))}
        </span>
        <PhotoPicker pose={pose} date={today()} sessionId={null} />
      </section>

      <section class="card l-col l-gap-12" aria-labelledby="photos-compare">
        <h2 class="card__title l-m0" id="photos-compare">
          Compare
        </h2>
        {comparing ? (
          pair.length === 2 ? (
            <Compare a={pair[0]} b={pair[1]} />
          ) : (
            <p class="state l-m0">Pick two photos below to see them side by side.{pair.length === 1 ? " (one selected)" : ""}</p>
          )
        ) : null}
        <button
          type="button"
          class="clay press btn t-muted"
          onClick={() => {
            setComparing(!comparing);
            setPicked([]);
            setOpen(null);
          }}
        >
          {comparing ? "Done comparing" : "Pick two photos to compare"}
        </button>
      </section>

      {viewing ? <Viewer p={viewing} onClose={() => setOpen(null)} /> : null}

      <div class="chip-wrap" role="group" aria-label="Pose filter">
        <button type="button" class="clay press chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All
        </button>
        {POSES.map(([k, label]) => (
          <button type="button" class="clay press chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      {photos.length && load?.status === "error" ? <p class="caption l-m0">{isOffline(load.error) ? "Offline" : "Couldn't refresh"}: showing the last saved copy.</p> : null}
      {shown.length ? null : photos.length ? (
        <Empty action={{ label: "Show all poses", onClick: () => setFilter("all"), testId: "photos-all-poses" }}>No {poseLabel(filter as Pose).toLowerCase()} photos yet.</Empty>
      ) : load?.status === "error" ? (
        <LoadError what="Couldn't load your photos." error={load.error} onRetry={() => void loadPhotos()} />
      ) : load?.status !== "done" ? (
        <Loading label="Loading your photos" heights={[150, 150]} />
      ) : (
        <Empty>No photos yet. After each session you can take a front, side and back photo.</Empty>
      )}
      {[...groups].map(([date, list]) => (
        <section class="l-col l-gap-8" aria-label={dateLong(date)}>
          <h2 class="section-label num">{dateLong(date)}</h2>
          <div class="l-grid-3 l-gap-8" data-testid="photo-group">
            {list.map((p) => (
              <button type="button" class="photo-thumb press" aria-pressed={comparing ? picked.includes(p.id) : undefined} data-testid="photo" onClick={() => tap(p)}>
                <span class="photo-thumb__frame well">
                  <img src={photoSrc(p, "thumb")} alt={`${photoLabel(p)} photo, ${dateLong(p.local_date)}`} loading="lazy" />
                </span>
                <span>
                  {poseLabel(p.pose)}
                  {pendingIds[p.id] ? " · queued" : ""}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
