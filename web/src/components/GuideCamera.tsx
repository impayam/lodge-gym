// The photo guide camera (SPEC-v10.1; Payam 2026-10-17: getUserMedia works in the iOS Home Screen app). An in-app
// camera so every progress photo is framed the same way: the body outline of the pose with a head line and a feet
// line (step back until head and feet touch them), the last photo of the pose as a faint ghost (toggle), a level from
// the motion sensor (violet when the phone is upright; the shutter warns past 3°; hidden when motion is denied), a
// 3 / 5 / 10 s timer with a countdown beep and flash, and a burst of 3 to keep the best one. Camera, timer, ghost and
// the outline's size and position are remembered per pose. The kept photo goes through the usual pipeline (resize,
// metadata stripped, R2, offline queue). No pose detection: everything runs on the phone without a model download.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Pose } from "../../../worker/lib/types";
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
} from "../lib/camera";
import { addPhoto, photoSrc, useStore } from "../store";
import { Sheet } from "./Sheet";

const POSES: [Pose, string][] = [
  ["front", "Front"],
  ["side", "Side"],
  ["back", "Back"],
];

type Phase = { kind: "starting" } | { kind: "live" } | { kind: "count"; left: number } | { kind: "burst" } | { kind: "pick"; shots: { blob: Blob; url: string }[] } | { kind: "saving" } | { kind: "error"; text: string };

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The sheet's slide (--t-sheet, 300 ms) and a little more. */
const SHEET_MS = 350;

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
    <Sheet open={open} onClose={onClose} title="Progress photo" sub="Head on the top line, feet on the bottom line" testId="guide-camera">
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
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const cancelled = useRef(false);
  const photos = useStore((s) => s.photos);
  const ghostPhoto = photos.find((p) => p.pose === pose) ?? null;
  const g = outline(pose, set);

  const change = (patch: Partial<CameraSettings>) => {
    const next = { ...set, ...patch };
    setSet(next);
    saveCameraSettings(pose, next);
  };

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
    setPose(p);
    setSet(loadCameraSettings(p));
  };

  const attach = () => {
    const v = video.current;
    if (!v || !stream.current) return;
    v.srcObject = null;
    v.srcObject = stream.current;
    void v.play().catch(() => undefined);
  };

  const frame = async (): Promise<Blob | null> => {
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
    const w = Math.min(vw, Math.round((vh * FRAME_W) / FRAME_H));
    const h = Math.min(vh, Math.round((w * FRAME_H) / FRAME_W));
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    if (set.facing === "user") {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(v, (vw - w) / 2, (vh - h) / 2, w, h, 0, 0, w, h);
    return new Promise((r) => c.toBlob((b) => r(b), "image/jpeg", 0.92));
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
    const shots: { blob: Blob; url: string }[] = [];
    for (let i = 0; i < BURST; i++) {
      if (cancelled.current) return;
      beep(audio.current, true);
      if (!reducedMotion()) {
        setFlash(true);
        setTimeout(() => setFlash(false), 120);
      }
      const b = await frame();
      if (b) shots.push({ blob: b, url: URL.createObjectURL(b) });
      if (i < BURST - 1) await wait(BURST_GAP_MS);
    }
    if (!shots.length) return setPhase({ kind: "error", text: "No picture came from the camera. Try again." });
    setPhase({ kind: "pick", shots });
  };

  const keep = async (blob: Blob, shots: { url: string }[]) => {
    setPhase({ kind: "saving" });
    try {
      await addPhoto(blob, pose, date, sessionId);
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
          {phase.shots.map((s, i) => (
            <button type="button" class="photo-thumb press" data-testid="camera-shot" aria-label={`Keep photo ${i + 1} of ${phase.shots.length}`} onClick={() => void keep(s.blob, phase.shots)}>
              <span class="photo-thumb__frame well">
                <img src={s.url} alt="" />
              </span>
              <span aria-hidden="true">Keep {fmtNum(i + 1)}</span>
            </button>
          ))}
        </div>
        <button type="button" class="clay press btn t-muted" data-testid="camera-retake" onClick={() => retake(phase.shots)}>
          Take again
        </button>
      </div>
    );

  return (
    <div class="l-col l-gap-12" data-testid="camera-live" data-pose={pose} data-phase={phase.kind}>
      {tips ? (
        <section class="callout" data-testid="camera-tips">
          <span class="t-title">For photos you can compare</span>
          <span class="ex-card__meta">Same place, same light, same time of day. Relaxed pose, same clothing. Lean the phone upright at hip height and use the timer.</span>
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
          <line x1={0} x2={FRAME_W} y1={g.feetY} y2={g.feetY} stroke="var(--pink)" stroke-width={1.5} stroke-dasharray="6 5" data-testid="camera-feet-line" />
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
                if (f) void keep(f, []);
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
          aria-label={ghostPhoto ? "Show the last photo of this pose faintly" : "No earlier photo of this pose"}
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
            value={Math.round(set.scale * 100)}
            onInput={(e) => change({ scale: Number((e.currentTarget as HTMLInputElement).value) / 100 })}
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
            value={Math.round(set.offset * 100)}
            onInput={(e) => change({ offset: Number((e.currentTarget as HTMLInputElement).value) / 100 })}
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
