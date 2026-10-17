// The photo guide camera (SPEC-v10.1; Payam 2026-10-17: getUserMedia works in the iOS Home Screen app). An in-app
// camera so every progress photo is framed the same way: the body outline of the pose with two guide lines, the last
// photo of the same pose and framing as a faint ghost (toggle), a level from the motion sensor (violet when the phone
// is upright; the shutter warns past 3°; hidden when motion is denied), a 3 / 5 / 10 s timer with a countdown beep and
// flash, and a burst of 3 to keep the best one.
//
// The on-device pose check (PR #26 review, Payam 2026-10-17; MediaPipe's lite pose model, ../lib/poseModel.ts) finds
// the framing without a choice: ankles in the frame is a full-body photo (someone else takes it; head and feet on the
// lines), otherwise an upper-body one (in a mirror with the phone in hand; head and waist on the lines). The lines, the
// outline, the ghost and the saved framing follow it, and one hint ("Step back a bit", "Move left a bit") brings the
// body onto the lines, live and under each shot before keeping it. Camera, timer, ghost, the framing and each
// framing's line size and position are remembered per pose. The kept photo, with its framing, goes through the usual
// pipeline (resize, metadata stripped, R2, offline queue). Nothing leaves the phone for the check.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { FRAMING_LABEL } from "../../../worker/lib/photoGroups";
import type { Framing, Pose } from "../../../worker/lib/types";
import { fmtNum } from "../format";
import {
  BURST,
  BURST_GAP_MS,
  FRAME_H,
  FRAME_W,
  MAX_TILT,
  OFFSET_RANGE,
  SCALE_RANGE,
  TIMERS,
  isLevel,
  loadCameraSettings,
  markTipsSeen,
  outline,
  saveCameraSettings,
  tilt,
  tipsSeen,
  type CameraSettings,
  type Fit,
} from "../lib/camera";
import { framingStart, nextFraming, poseHint, readPose, type FramingState, type PoseReading } from "../lib/pose";
import type { PoseDetector } from "../lib/poseModel";
import { addPhoto, photoSrc, useStore } from "../store";
import { Sheet } from "./Sheet";

const POSES: [Pose, string][] = [
  ["front", "Front"],
  ["side", "Side"],
  ["back", "Back"],
];

/** One burst photo and what the pose check read on it (null: nobody, or no check). */
interface Shot {
  blob: Blob;
  url: string;
  reading: PoseReading | null;
}

type Phase = { kind: "starting" } | { kind: "live" } | { kind: "count"; left: number } | { kind: "burst" } | { kind: "pick"; shots: Shot[] } | { kind: "saving" } | { kind: "error"; text: string };

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The sheet's slide (--t-sheet, 300 ms) and a little more. */
const SHEET_MS = 350;
/** The live pose check runs this often (the model takes some tens of ms per look on an iPhone). */
const CHECK_MS = 400;
/** The pose check looks at a small copy of the 3:4 frame. */
const CHECK_W = 240;
const CHECK_H = 320;

/** Draws the 3:4 part `sx, sy, sw, sh` of `src` into `c` at the check's size (mirrored for the front camera, as shown). */
function sample(c: HTMLCanvasElement, src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, mirror: boolean): HTMLCanvasElement | null {
  c.width = CHECK_W;
  c.height = CHECK_H;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(mirror ? -1 : 1, 0, 0, 1, mirror ? CHECK_W : 0, 0);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, CHECK_W, CHECK_H);
  return c;
}

/** The guide of one framing as shares of the frame height (for the hint). */
const guideOf = (pose: Pose, fit: Fit, framing: Framing) => {
  const o = outline(pose, fit, framing);
  return { framing, headY: o.headY / FRAME_H, baseY: o.baseY / FRAME_H };
};

/** A short beep for the countdown (no sound file: Web Audio). Silent where audio is not allowed. */
function beep(ctx: AudioContext | null, high = false) {
  if (!ctx) return;
  try {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = high ? 1320 : 880;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.12);
  } catch {
    // No sound; the countdown number still shows.
  }
}

interface OrientationPermission {
  requestPermission?: () => Promise<"granted" | "denied">;
}

export function GuideCamera({ open, onClose, date, sessionId, pose: startPose, onSaved }: { open: boolean; onClose: () => void; date: string; sessionId: string | null; pose: Pose; onSaved?: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Progress photo" sub="Head and feet, or head and waist, on the lines" testId="guide-camera">
      {open ? <CameraBody onClose={onClose} date={date} sessionId={sessionId} startPose={startPose} onSaved={onSaved} /> : null}
    </Sheet>
  );
}

function CameraBody({ onClose, date, sessionId, startPose, onSaved }: { onClose: () => void; date: string; sessionId: string | null; startPose: Pose; onSaved?: () => void }) {
  const [pose, setPose] = useState<Pose>(startPose === "other" ? "front" : startPose);
  const [set, setSet] = useState<CameraSettings>(() => loadCameraSettings(startPose));
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [deg, setDeg] = useState<number | null>(null);
  const [motion, setMotion] = useState<"off" | "on" | "denied">("off");
  const [tips, setTips] = useState(!tipsSeen());
  const [flash, setFlash] = useState(false);
  // The pose check: the model's state, the framing it holds the guide in, and the latest reading.
  const [check, setCheck] = useState<"loading" | "ready" | "off">("loading");
  const [fs, setFs] = useState<FramingState>(() => framingStart(set.framing));
  const [reading, setReading] = useState<PoseReading | null>(null);
  const detector = useRef<PoseDetector | null>(null);
  const checkCanvas = useRef<HTMLCanvasElement | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const cancelled = useRef(false);
  const photos = useStore((s) => s.photos);
  const framing = fs.framing;
  const fit = set.fit[framing];
  // Only a photo of the same pose and framing is a useful ghost (and the only one Before · After compares with).
  const ghostPhoto = photos.find((p) => p.pose === pose && p.framing === framing) ?? null;
  const g = outline(pose, fit, framing);
  const hint = check === "ready" ? poseHint(reading, guideOf(pose, fit, framing)) : null;

  const change = (patch: Partial<CameraSettings>) => {
    setSet((cur) => {
      const next = { ...cur, ...patch };
      saveCameraSettings(pose, next);
      return next;
    });
  };
  const changeFit = (patch: Partial<Fit>) => change({ fit: { ...set.fit, [framing]: { ...fit, ...patch } } });

  // The pose check's model, loaded once per app run (about 18 MB the first time, then from the service worker).
  useEffect(() => {
    let gone = false;
    import("../lib/poseModel")
      .then((m) => m.loadPoseDetector())
      .then((d) => {
        if (gone) return;
        detector.current = d;
        setCheck("ready");
      })
      .catch(() => {
        if (!gone) setCheck("off");
      });
    return () => {
      gone = true;
    };
  }, []);

  // A framing the check settled on is this pose's framing from now on (the guide opens with it next time).
  useEffect(() => {
    if (fs.detected && set.framing !== fs.framing) change({ framing: fs.framing });
  }, [fs.framing, fs.detected]);

  /** What the check reads on the camera's frame now (null without a frame or a body). */
  const look = (): PoseReading | null => {
    const v = video.current;
    const d = detector.current;
    if (!v || !d || !v.videoWidth) return null;
    const { w, h } = crop(v);
    checkCanvas.current ??= document.createElement("canvas");
    const c = sample(checkCanvas.current, v, (v.videoWidth - w) / 2, (v.videoHeight - h) / 2, w, h, set.facing === "user");
    try {
      return c ? readPose(d.detect(c)) : null;
    } catch {
      return null;
    }
  };

  // The live check while the preview shows (not while the burst runs or a shot is picked).
  const watching = check === "ready" && (phase.kind === "live" || phase.kind === "count");
  useEffect(() => {
    if (!watching) return;
    let blank = 0;
    const t = window.setInterval(() => {
      // A preview that shows no frame yet gets its stream again now and then (as frame() does before a shot).
      if (video.current && !video.current.videoWidth && ++blank % 3 === 0) attach();
      const r = look();
      setReading(r);
      setFs((prev) => nextFraming(prev, r));
    }, CHECK_MS);
    return () => clearInterval(t);
  }, [watching, set.facing]);

  // The camera: the chosen side, 1× (no digital zoom), restarted when the side changes.
  useEffect(() => {
    let stop = false;
    setPhase({ kind: "starting" });
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      setPhase({ kind: "error", text: "This browser has no in-app camera. Use From library, or the iPhone camera." });
      return;
    }
    media
      .getUserMedia({ video: { facingMode: set.facing, width: { ideal: 1440 }, height: { ideal: 1920 } }, audio: false })
      .then(async (s) => {
        if (stop) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        const track = s.getVideoTracks()[0];
        const caps = (track?.getCapabilities?.() ?? {}) as { zoom?: { min: number } };
        if (caps.zoom) await track.applyConstraints({ advanced: [{ zoom: Math.max(1, caps.zoom.min) } as MediaTrackConstraintSet] }).catch(() => undefined);
        // WebKit does not start a video attached while it is off screen (the sheet is still sliding up): attach the
        // stream once the sheet is in place. play() may never settle, so nothing waits for it.
        await wait(SHEET_MS);
        if (stop) return;
        attach();
        setPhase({ kind: "live" });
      })
      .catch((e: unknown) => {
        if (stop) return;
        const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
        setPhase({ kind: "error", text: denied ? "Camera access is off. Allow it in Settings → Safari → Camera, or use From library." : "The camera could not start. Use From library, or try again." });
      });
    return () => {
      stop = true;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
  }, [set.facing]);

  // The level: the phone's front-back tilt from the motion sensor (listening from the render that shows it).
  useLayoutEffect(() => {
    if (motion !== "on") return;
    // An event without a reading (some browsers send one when listening starts) keeps the last value.
    const on = (e: DeviceOrientationEvent) => {
      const t = tilt(e.beta);
      if (t !== null) setDeg(t);
    };
    window.addEventListener("deviceorientation", on);
    return () => window.removeEventListener("deviceorientation", on);
  }, [motion]);

  useEffect(
    () => () => {
      cancelled.current = true;
      void audio.current?.close().catch(() => undefined);
    },
    []
  );

  const startLevel = async () => {
    const DOE = (window as unknown as { DeviceOrientationEvent?: OrientationPermission }).DeviceOrientationEvent;
    if (!DOE) return setMotion("denied");
    try {
      // iOS asks once; elsewhere the events just come.
      const r = DOE.requestPermission ? await DOE.requestPermission() : "granted";
      setMotion(r === "granted" ? "on" : "denied");
    } catch {
      setMotion("denied");
    }
  };

  const pickPose = (p: Pose) => {
    const next = loadCameraSettings(p);
    setPose(p);
    setSet(next);
    // The framing found in this camera session holds for the next pose; otherwise that pose's own.
    setFs((prev) => (prev.detected ? prev : framingStart(next.framing)));
  };

  const attach = () => {
    const v = video.current;
    if (!v || !stream.current) return;
    v.srcObject = null;
    v.srcObject = stream.current;
    void v.play().catch(() => undefined);
  };

  /** The 3:4 middle of the camera frame. */
  const crop = (v: HTMLVideoElement) => {
    const w = Math.min(v.videoWidth, Math.round((v.videoHeight * FRAME_W) / FRAME_H));
    return { w, h: Math.min(v.videoHeight, Math.round((w * FRAME_H) / FRAME_W)) };
  };

  const frame = async (): Promise<Omit<Shot, "url"> | null> => {
    const v = video.current;
    if (!v) return null;
    // The first frame may still be on its way: attach the stream again and wait for it, up to 3 s.
    if (!v.videoWidth) {
      attach();
      await new Promise<void>((done) => {
        const end = () => {
          clearTimeout(t);
          v.removeEventListener("loadeddata", end);
          done();
        };
        const t = setTimeout(end, 3000);
        v.addEventListener("loadeddata", end);
      });
    }
    if (!v.videoWidth) return null;
    const c = document.createElement("canvas");
    // The 3:4 middle of the camera frame, as the preview shows it (mirrored for the front camera).
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const { w, h } = crop(v);
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    if (set.facing === "user") {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(v, (vw - w) / 2, (vh - h) / 2, w, h, 0, 0, w, h);
    // The check on the photo itself (already as shown, so not mirrored again).
    let reading: PoseReading | null = null;
    const d = detector.current;
    if (d) {
      checkCanvas.current ??= document.createElement("canvas");
      const small = sample(checkCanvas.current, c, 0, 0, w, h, false);
      try {
        reading = small ? readPose(d.detect(small)) : null;
      } catch {
        reading = null;
      }
    }
    const blob = await new Promise<Blob | null>((r) => c.toBlob((b) => r(b), "image/jpeg", 0.92));
    return blob ? { blob, reading } : null;
  };

  const shoot = async () => {
    if (phase.kind !== "live") return;
    if (!audio.current && typeof AudioContext !== "undefined") {
      try {
        audio.current = new AudioContext();
      } catch {
        audio.current = null;
      }
    }
    for (let left = set.timer; left > 0; left--) {
      if (cancelled.current) return;
      setPhase({ kind: "count", left });
      beep(audio.current);
      await wait(1000);
    }
    setPhase({ kind: "burst" });
    const shots: Shot[] = [];
    for (let i = 0; i < BURST; i++) {
      if (cancelled.current) return;
      beep(audio.current, true);
      if (!reducedMotion()) {
        setFlash(true);
        setTimeout(() => setFlash(false), 120);
      }
      const f = await frame();
      if (f) shots.push({ ...f, url: URL.createObjectURL(f.blob) });
      if (i < BURST - 1) await wait(BURST_GAP_MS);
    }
    if (!shots.length) return setPhase({ kind: "error", text: "No picture came from the camera. Try again." });
    setPhase({ kind: "pick", shots });
  };

  /** The framing a kept photo is saved with: what the check read on it, else what it held live; null without a check. */
  const framingFor = (r: PoseReading | null): Framing | null => r?.framing ?? (fs.detected ? fs.framing : null);

  const keep = async (blob: Blob, shots: { url: string }[], kept: Framing | null) => {
    setPhase({ kind: "saving" });
    try {
      await addPhoto(blob, pose, date, sessionId, kept);
      shots.forEach((s) => URL.revokeObjectURL(s.url));
      onSaved?.();
      onClose();
    } catch {
      setPhase({ kind: "error", text: "The photo could not be saved. Try again." });
    }
  };

  const retake = (shots: { url: string }[]) => {
    shots.forEach((s) => URL.revokeObjectURL(s.url));
    setPhase({ kind: "live" });
  };

  const level = motion === "on" ? deg : null;
  const tilted = level !== null && !isLevel(level);

  if (phase.kind === "pick")
    return (
      <div class="l-col l-gap-12" data-testid="camera-pick">
        <span class="ex-card__meta">Keep the best of the three.</span>
        <div class="l-grid-3 l-gap-8">
          {phase.shots.map((s, i) => {
            const kept = framingFor(s.reading);
            // Under each shot, how it sits on the lines of its own framing (no check: nothing to say).
            const h = s.reading && kept ? poseHint(s.reading, guideOf(pose, set.fit[kept], kept)) : null;
            return (
              <button
                type="button"
                class="photo-thumb press"
                data-testid="camera-shot"
                data-framing={kept ?? ""}
                data-hint={h?.key ?? ""}
                aria-label={`Keep photo ${i + 1} of ${phase.shots.length}${kept ? `, ${FRAMING_LABEL[kept].toLowerCase()}` : ""}${h ? `. ${h.text}` : ""}`}
                onClick={() => void keep(s.blob, phase.shots, kept)}
              >
                <span class="photo-thumb__frame well">
                  <img src={s.url} alt="" />
                </span>
                <span aria-hidden="true">Keep {fmtNum(i + 1)}</span>
                {h ? (
                  <span class={`caption ${h.key === "ok" ? "" : "t-orange"}`} aria-hidden="true" data-testid="camera-shot-hint">
                    {h.text}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <button type="button" class="clay press btn t-muted" data-testid="camera-retake" onClick={() => retake(phase.shots)}>
          Take again
        </button>
      </div>
    );

  return (
    <div class="l-col l-gap-12" data-testid="camera-live" data-pose={pose} data-phase={phase.kind} data-framing={framing} data-check={check}>
      {tips ? (
        <section class="callout" data-testid="camera-tips">
          <span class="t-title">For photos you can compare</span>
          <span class="ex-card__meta">
            Same place, same light, same time of day. Relaxed pose, same clothing. Lean the phone upright at hip height and use the timer, or hold it at chest height in a mirror for the upper body.
          </span>
          <button
            type="button"
            class="clay press btn-sm btn--fit t-pink"
            data-testid="camera-tips-ok"
            onClick={() => {
              markTipsSeen();
              setTips(false);
            }}
          >
            Got it
          </button>
        </section>
      ) : null}
      <span class="segmented l-full" role="group" aria-label="Pose">
        {POSES.map(([p, label]) => (
          <button type="button" class="press l-grow" aria-pressed={pose === p} data-testid={`camera-pose-${p}`} onClick={() => pickPose(p)}>
            {label}
          </button>
        ))}
      </span>
      {/* The framing the pose check found and its one hint, above the preview where the eyes are while lining up. */}
      <div class="l-row l-between l-gap-8">
        <span class="badge t-violet" data-testid="camera-framing" data-framing={framing}>
          {FRAMING_LABEL[framing]}
        </span>
        <span class={`caption l-grow ${hint && hint.key !== "ok" ? "t-orange" : ""}`} role="status" data-testid="camera-hint" data-hint={hint?.key ?? check} style={{ textAlign: "right" }}>
          {check === "loading" ? "Loading the pose check…" : check === "off" ? "Pose check unavailable: line up by eye." : hint!.text}
        </span>
      </div>
      <div class="photo-overlay well" data-testid="camera-frame">
        <video
          ref={video}
          playsInline
          muted
          aria-label={`Camera preview, ${pose} pose`}
          style={{ position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "cover", transform: set.facing === "user" ? "scaleX(-1)" : undefined }}
        />
        {set.ghost && ghostPhoto ? (
          <img src={photoSrc(ghostPhoto, "full")} alt="" data-testid="camera-ghost" style={{ opacity: 0.25, pointerEvents: "none" }} />
        ) : null}
        <svg viewBox={`0 0 ${FRAME_W} ${FRAME_H}`} preserveAspectRatio="none" aria-hidden="true" data-testid="camera-outline" style={{ position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" }}>
          <line x1={0} x2={FRAME_W} y1={g.headY} y2={g.headY} stroke="var(--pink)" stroke-width={1.5} stroke-dasharray="6 5" data-testid="camera-head-line" />
          <line x1={0} x2={FRAME_W} y1={g.baseY} y2={g.baseY} stroke="var(--pink)" stroke-width={1.5} stroke-dasharray="6 5" data-testid={g.base === "feet" ? "camera-feet-line" : "camera-waist-line"} />
          <circle cx={g.head.cx} cy={g.head.cy} r={g.head.r} fill="none" stroke="var(--ink)" stroke-opacity={0.8} stroke-width={1.5} />
          <path d={g.d} fill="none" stroke="var(--ink)" stroke-opacity={0.8} stroke-width={1.5} stroke-linejoin="round" />
        </svg>
        <div class="stage__top">
          {motion === "on" ? (
            <span class={`badge ${tilted ? "t-orange" : "t-violet"}`} data-testid="camera-level" data-level={level === null ? "none" : tilted ? "tilted" : "level"} role="status">
              {level === null ? "Level…" : tilted ? `Tilted ${fmtNum(level, 1)}°` : "Level"}
            </span>
          ) : motion === "off" ? (
            <button type="button" class="clay press btn-sm t-muted" data-testid="camera-level-on" onClick={() => void startLevel()}>
              Show level
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            class="clay press btn-sm t-muted"
            data-testid="camera-flip"
            aria-label={set.facing === "user" ? "Use the back camera" : "Use the front camera"}
            onClick={() => change({ facing: set.facing === "user" ? "environment" : "user" })}
          >
            {set.facing === "user" ? "Back camera" : "Front camera"}
          </button>
        </div>
        {phase.kind === "starting" ? <div class="stage__msg">Starting the camera…</div> : null}
        {phase.kind === "count" ? (
          <div class="stage__msg" role="timer" aria-live="assertive" data-testid="camera-count">
            <span class="big-num big-num--54 num">{fmtNum(phase.left)}</span>
          </div>
        ) : null}
        {phase.kind === "burst" || phase.kind === "saving" ? <div class="stage__msg">{phase.kind === "burst" ? "Taking 3 photos…" : "Saving…"}</div> : null}
        {flash ? <div aria-hidden="true" data-testid="camera-flash" style={{ position: "absolute", inset: "0", background: "var(--ink)", opacity: 0.6 }} /> : null}
      </div>
      {phase.kind === "error" ? (
        <div class="l-col l-gap-8">
          <p class="state l-m0" role="alert" data-testid="camera-error">
            {phase.text}
          </p>
          <label class="clay press btn btn--fit file-pick t-muted">
            <input
              type="file"
              accept="image/*"
              capture="environment"
              data-testid="camera-native"
              onChange={(e) => {
                const el = e.currentTarget as HTMLInputElement;
                const f = el.files?.[0];
                el.value = "";
                // The iPhone camera's photo has no pose check: its framing is not known.
                if (f) void keep(f, [], null);
              }}
            />
            Use the iPhone camera
          </label>
        </div>
      ) : null}
      {tilted ? (
        <span class="caption t-orange" data-testid="camera-tilt-warning" role="status">
          The phone leans {fmtNum(level!, 1)}° (more than {fmtNum(MAX_TILT)}°): stand it upright so the photo matches the last one.
        </span>
      ) : null}
      <div class="l-row l-between l-gap-8">
        <span class="segmented" role="group" aria-label="Timer">
          {TIMERS.map((t) => (
            <button type="button" class="press" aria-pressed={set.timer === t} data-testid={`camera-timer-${t}`} aria-label={t ? `Timer ${t} seconds` : "No timer"} onClick={() => change({ timer: t })}>
              {t ? `${fmtNum(t)} s` : "Off"}
            </button>
          ))}
        </span>
        <button
          type="button"
          class="clay press chip"
          aria-pressed={set.ghost}
          data-testid="camera-ghost-toggle"
          disabled={!ghostPhoto}
          aria-label={ghostPhoto ? "Show the last photo of this pose and framing faintly" : "No earlier photo of this pose and framing"}
          onClick={() => change({ ghost: !set.ghost })}
        >
          Ghost
        </button>
      </div>
      <div class="l-grid-2 l-gap-8">
        <label class="form-field">
          <span class="form-field__label">Outline size</span>
          <input
            class="range"
            type="range"
            data-testid="camera-scale"
            min={SCALE_RANGE[0] * 100}
            max={SCALE_RANGE[1] * 100}
            value={Math.round(fit.scale * 100)}
            onInput={(e) => changeFit({ scale: Number((e.currentTarget as HTMLInputElement).value) / 100 })}
          />
        </label>
        <label class="form-field">
          <span class="form-field__label">Outline position</span>
          <input
            class="range"
            type="range"
            data-testid="camera-offset"
            min={OFFSET_RANGE[0] * 100}
            max={OFFSET_RANGE[1] * 100}
            value={Math.round(fit.offset * 100)}
            onInput={(e) => changeFit({ offset: Number((e.currentTarget as HTMLInputElement).value) / 100 })}
          />
        </label>
      </div>
      <button type="button" class="clay press btn t-pink" data-testid="camera-shutter" disabled={phase.kind !== "live"} onClick={() => void shoot()}>
        {set.timer ? `Take 3 photos in ${fmtNum(set.timer)} s` : "Take 3 photos"}
        {tilted ? " (phone tilted)" : ""}
      </button>
    </div>
  );
}
