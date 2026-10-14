// 3D anatomy scene of the exercise picker (SPEC-v6 §4–§5). This module and three.js form their own chunk, loaded only
// when the picker's Body tab opens. The model is fetched and decoded once per app run; each opened view gets its own
// renderer, materials and GPU buffers and releases them all when it closes (dispose), keeping only the decoded model.
//
//  - Drag turns the body around the vertical axis; pinch zooms between a close-up limit outside the body and the
//    whole-body view; there is no panning. Front / Back turn it 180° in TURN_MS.
//  - A tap picks the mapped muscle under the finger (anatomy-map.ts). The pick renders the 49 × 49 px around the tap
//    with one flat colour per app muscle (unmapped meshes black, still hiding what is behind them) and takes the
//    nearest coloured pixel within 24 px, so a near miss still finds the muscle and an unmapped muscle falls through.
//  - Frames are drawn on demand: while the body moves under a finger, its damping or a camera move runs, never when idle.
//  - Reports (SPEC-v6 §8) tint each mapped muscle with a colour of its own (its weekly status) and draw unmapped
//    muscles dark; the selected muscle keeps its colour and glows.

import {
  Color,
  DirectionalLight,
  HemisphereLight,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DRACOLoader, DRACO_GLTF_CONFIG } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { areaDef, type BodyArea, type FigureView } from "../../../worker/lib/bodyAreas";
import { CANONICAL_MUSCLES, type Muscle } from "../../../worker/lib/muscles";
import { GLB_URL } from "./anatomy-asset";
import { AREA_PRESETS, FOV_DEG, TURN_MS, cameraPosition, frameBox, lerpPose, minDistance, nearestYaw, yawOf, type Box, type CameraPose, type Vec3 } from "./anatomy-camera";
import { anatomyOf, baseName } from "./anatomy-map";
import { token } from "./tokens";

type Kind = "muscle" | "bone" | "other";
interface Part {
  mesh: Mesh;
  /** Model name without the left/right suffix. */
  name: string;
  kind: Kind;
  /** App muscle of a mapped muscle mesh, else null (not tappable). */
  muscle: Muscle | null;
}
interface Model {
  root: Object3D;
  parts: Part[];
  body: Box;
  /** Bounding box of each app muscle's meshes, both sides. */
  boxes: Map<Muscle, Box>;
}

const PICK_RADIUS = 24;
const PICK_SIZE = 2 * PICK_RADIUS + 1;
/** Id drawn by every model mesh that cannot be tapped: it hides what is behind it but is never picked. */
const SOLID = 255;
// Muscles in a muted red, a little dark so the key light shapes them; bones and other tissue close to the stage colour
// so they recede; the selected muscle in a lightened app accent that glows (emissive), clearly the brightest thing.
/** The model colours, from the --model-* tokens (web/src/styles/tokens.css). */
const modelColor = (part: "bg" | "muscle" | "context" | "bone") => token(`--model-${part}`);
/** Light from the upper front (camera-relative, so it follows the turn), a soft fill from the other side, low ambient. */
const LIGHTS = { ambient: 0.35, key: 3.6, fill: 0.6 };

let model: Promise<Model> | null = null;

function emptyBox(): Box {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}
function grow(b: Box, o: Object3D) {
  const g = (o as Mesh).geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  const bb = g.boundingBox!.clone().applyMatrix4(o.matrixWorld);
  for (let i = 0; i < 3; i++) {
    b.min[i] = Math.min(b.min[i], bb.min.getComponent(i));
    b.max[i] = Math.max(b.max[i], bb.max.getComponent(i));
  }
}
function unite(boxes: Box[]): Box {
  const out = emptyBox();
  for (const b of boxes)
    for (let i = 0; i < 3; i++) {
      out.min[i] = Math.min(out.min[i], b.min[i]);
      out.max[i] = Math.max(out.max[i], b.max[i]);
    }
  return out;
}

/** Fetches and decodes the model once per app run (the service worker serves it from cache after the first time). */
function loadModel(): Promise<Model> {
  model ??= (async () => {
    // three's glTF decoder build, which Vite copies into /assets/ (self-hosted, content-hashed).
    const draco = new DRACOLoader().setDecoderPath(DRACO_GLTF_CONFIG);
    try {
      const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync(GLB_URL);
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const json = gltf.parser.json as { nodes: { name?: string }[] };
      const parts: Part[] = [];
      const loaded = new Set<Material>();
      root.traverse((o) => {
        if (!(o as Mesh).isMesh) return;
        const mesh = o as Mesh;
        const node = gltf.parser.associations.get(mesh)?.nodes;
        const name = baseName((node !== undefined ? json.nodes[node].name : undefined) ?? mesh.name);
        const type = mesh.userData.type;
        const kind: Kind = type === "muscle" ? "muscle" : type === "bone" ? "bone" : "other";
        parts.push({ mesh, name, kind, muscle: kind === "muscle" ? anatomyOf(name)?.muscle ?? null : null });
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) loaded.add(m);
        mesh.matrixAutoUpdate = false;
      });
      // Every view brings its own materials; the model's two are never drawn.
      for (const m of loaded) m.dispose();
      const body = emptyBox();
      const byMuscle = new Map<Muscle, Box>();
      for (const p of parts) {
        grow(body, p.mesh);
        if (p.muscle) {
          if (!byMuscle.has(p.muscle)) byMuscle.set(p.muscle, emptyBox());
          grow(byMuscle.get(p.muscle)!, p.mesh);
        }
      }
      return { root, parts, body, boxes: byMuscle };
    } finally {
      draco.dispose();
    }
  })();
  model.catch(() => (model = null));
  return model;
}

export interface ViewStats {
  /** ms from the picker opening to the model being decoded. */
  loadMs: number;
  /** ms from the picker opening to the first drawn frame (interactive). */
  interactiveMs: number;
  /** Whether this run already had the model decoded (a second open). */
  warm: boolean;
  /** Frames per second over the last continuous movement of at least half a second (null before one). */
  fps: number | null;
}

/** Test and measurement hook: live views, WebGL contexts and the stats of the latest view. */
export const hook = {
  live: 0,
  contexts: 0,
  view: null as AnatomyView | null,
  stats: null as ViewStats | null,
};
(globalThis as unknown as { __anatomy: typeof hook }).__anatomy = hook;

export interface ViewOptions {
  /** Called with the muscle a tap picked, or null when the tap hit nothing tappable (the picker then calls select). */
  onSelect: (muscle: Muscle | null) => void;
  /** Called after a drag with the side that now faces the viewer. */
  onFacing: (view: FigureView) => void;
  /** Highlight colour (the app accent). */
  accent: string;
  /** performance.now() when the picker opened, for the load-time stats. */
  openedAt: number;
  /** A colour per app muscle (Reports); unmapped muscles are then drawn dark. Without it, the picker's muscle colour. */
  tints?: Map<Muscle, string>;
}

interface Tint {
  base: MeshStandardMaterial;
  glow: MeshStandardMaterial;
}

export class AnatomyView {
  readonly canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV_DEG, 1, 0.02, 20);
  private controls: OrbitControls;
  private pickTarget = new WebGLRenderTarget(PICK_SIZE, PICK_SIZE);
  private pickBuffer = new Uint8Array(PICK_SIZE * PICK_SIZE * 4);
  private mats: { muscle: MeshStandardMaterial; context: MeshStandardMaterial; bone: MeshStandardMaterial; highlight: MeshStandardMaterial; hidden: MeshBasicMaterial; ids: Map<Muscle, MeshBasicMaterial> };
  private model!: Model;
  private tints: Map<Muscle, string> | null;
  private tintMats = new Map<string, Tint>();
  private area: BodyArea | null = null;
  private selected: Muscle | null = null;
  private pose: CameraPose = { target: [0, 1, 0], distance: 4, yaw: 0 };
  private move: { from: CameraPose; to: CameraPose; start: number; ms: number; done?: () => void } | null = null;
  private raf = 0;
  private frames: number[] = [];
  private resize: ResizeObserver;
  private down: { id: number; x: number; y: number; t: number } | null = null;
  private multi = false;
  private disposed = false;
  stats: ViewStats = { loadMs: 0, interactiveMs: 0, warm: false, fps: null };

  /** Creates the view inside `host` and resolves once the model is drawn. Throws without WebGL 2 or the model. */
  static async create(host: HTMLElement, o: ViewOptions): Promise<AnatomyView> {
    const warm = model !== null;
    const v = new AnatomyView(host, o);
    try {
      v.model = await loadModel();
      if (v.disposed) return v;
      v.stats.warm = warm;
      v.stats.loadMs = Math.round(performance.now() - o.openedAt);
      v.attach();
      v.renderNow();
      v.stats.interactiveMs = Math.round(performance.now() - o.openedAt);
      hook.stats = v.stats;
      return v;
    } catch (e) {
      v.dispose();
      throw e;
    }
  }

  private constructor(
    private host: HTMLElement,
    private o: ViewOptions
  ) {
    this.tints = o.tints ?? null;
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.dataset.testid = "anatomy-canvas";
    host.appendChild(this.canvas);
    try {
      this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: "high-performance" });
    } catch (e) {
      // No WebGL 2: the picker falls back to its chips.
      this.canvas.remove();
      throw e;
    }
    hook.contexts++;
    hook.live++;
    hook.view = this;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.pickTarget.texture.colorSpace = NoColorSpace;
    this.scene.background = new Color(modelColor("bg"));
    // The stage is always dark: lift a dark accent (the light theme's) so the selection stays the brightest thing.
    const glow = new Color(o.accent);
    const hsl = { h: 0, s: 0, l: 0 };
    glow.getHSL(hsl);
    glow.setHSL(hsl.h, hsl.s, Math.max(hsl.l, 0.5));
    const surface = (color: string | Color) => new MeshStandardMaterial({ color, roughness: 0.62, metalness: 0 });
    this.mats = {
      muscle: surface(modelColor("muscle")),
      context: surface(modelColor("context")),
      bone: new MeshStandardMaterial({ color: modelColor("bone"), roughness: 0.9, metalness: 0 }),
      highlight: new MeshStandardMaterial({ color: glow, emissive: glow.clone().multiplyScalar(0.35), roughness: 0.5, metalness: 0 }),
      hidden: new MeshBasicMaterial({ color: new Color().setRGB(SOLID / 255, 0, 0, LinearSRGBColorSpace), toneMapped: false }),
      ids: new Map(
        CANONICAL_MUSCLES.map((m, i) => [m, new MeshBasicMaterial({ color: new Color().setRGB((i + 1) / 255, 0, 0, LinearSRGBColorSpace), toneMapped: false })])
      ),
    };
    this.scene.add(new HemisphereLight(0xffffff, 0x1c1c1c, LIGHTS.ambient));
    for (const [intensity, x, y, z] of [
      [LIGHTS.key, 0.7, 1.4, 1.1],
      [LIGHTS.fill, -1, 0.15, 0.7],
    ]) {
      const light = new DirectionalLight(0xffffff, intensity);
      light.position.set(x, y, z);
      // Aim along the view: the light keeps its place relative to the camera whatever the turn or close-up.
      light.target.position.set(0, 0, -1);
      this.camera.add(light, light.target);
    }
    this.scene.add(this.camera);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enablePan = false;
    this.controls.minPolarAngle = this.controls.maxPolarAngle = Math.PI / 2;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.9;
    this.controls.zoomSpeed = 0.8;
    // A vertical swipe still scrolls the page; horizontal drags turn the body and two fingers zoom.
    this.canvas.style.touchAction = "pan-y";
    this.controls.addEventListener("change", this.wake);
    this.controls.addEventListener("start", this.onStart);
    this.controls.addEventListener("end", this.onEnd);
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onCancel);
    // A click listener makes the canvas a tap target of its own, so WebKit's touch adjustment does not hand a tap on
    // the body to a button nearby (Front / Back, ← Body).
    this.canvas.addEventListener("click", this.onClick);
    this.resize = new ResizeObserver(() => this.fit());
  }

  private attach() {
    this.scene.add(this.model.root);
    this.paint();
    this.fit();
    this.resize.observe(this.host);
  }

  /* ---------------- camera ---------------- */

  private aspect() {
    const r = this.host.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r.width / r.height : 1;
  }

  /** The pose for the current area (or the whole body) seen from `yaw`. */
  private framed(yaw: number): CameraPose {
    const box = this.area ? unite(areaDef(this.area).muscles.flatMap((m) => this.model.boxes.get(m) ?? [])) : this.model.body;
    const pad = this.area ? AREA_PRESETS[this.area].pad : 1.06;
    return frameBox(box, yaw, this.aspect(), pad);
  }

  private limits(p: CameraPose) {
    const whole = frameBox(this.model.body, 0, this.aspect(), 1.06).distance;
    this.controls.minDistance = Math.min(p.distance, minDistance(this.model.body, p.target));
    this.controls.maxDistance = Math.max(p.distance, whole * 1.1);
  }

  private apply(p: CameraPose) {
    this.pose = p;
    this.controls.target.set(...p.target);
    this.camera.position.set(...cameraPosition(p));
    this.camera.lookAt(this.controls.target);
  }

  private current(): CameraPose {
    const t = this.controls.target;
    const d = new Vector3().subVectors(this.camera.position, t);
    return { target: [t.x, t.y, t.z], distance: Math.hypot(d.x, d.z), yaw: Math.atan2(d.x, d.z) };
  }

  private moveTo(to: CameraPose, animate: boolean) {
    this.limits(to);
    if (!animate) {
      this.move = null;
      this.apply(to);
      this.controls.update();
      this.wake();
      return;
    }
    const from = this.current();
    this.move = { from, to: { ...to, yaw: nearestYaw(from.yaw, to.yaw) }, start: performance.now(), ms: TURN_MS };
    this.controls.enabled = false;
    this.wake();
  }

  private fit() {
    const r = this.host.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    if (!this.move) this.moveTo(this.framed(this.current().yaw), false);
  }

  /* ---------------- state from the picker ---------------- */

  /** Close-up of an area (or back to the whole body), keeping the side the body faces unless the area opens on its own side. */
  setArea(area: BodyArea | null, view: FigureView, animate = true) {
    this.area = area;
    if (this.selected && area && !areaDef(area).muscles.includes(this.selected)) this.selected = null;
    this.paint();
    this.moveTo(this.framed(yawOf(view)), animate);
  }

  setView(view: FigureView, animate = true) {
    this.moveTo({ ...this.current(), yaw: yawOf(view) }, animate);
  }

  select(muscle: Muscle | null) {
    this.selected = muscle;
    this.paint();
    this.wake();
  }

  /** New colours per app muscle (Reports, when the week's numbers change). */
  setTints(tints: Map<Muscle, string>) {
    this.tints = tints;
    this.paint();
    this.wake();
  }

  /** The materials of one tint colour: as drawn, and selected (the same colour, glowing). */
  private tint(color: string): Tint {
    let t = this.tintMats.get(color);
    if (!t) {
      const c = new Color(color);
      t = {
        base: new MeshStandardMaterial({ color: c, roughness: 0.62, metalness: 0 }),
        glow: new MeshStandardMaterial({ color: c, emissive: c.clone().multiplyScalar(0.6), roughness: 0.5, metalness: 0 }),
      };
      t.base.userData.tint = t.glow.userData.tint = color;
      this.tintMats.set(color, t);
    }
    return t;
  }

  private tappable(m: Muscle | null): m is Muscle {
    return m !== null && (!this.area || areaDef(this.area).muscles.includes(m));
  }

  /** Materials for the current area and selection. */
  private paint() {
    const tints = this.tints;
    for (const p of this.model.parts) {
      if (p.kind !== "muscle") p.mesh.material = this.mats.bone;
      else if (tints) {
        // Reports: unmapped muscles, and in a close-up the other areas' muscles, dark; mapped ones in their colour.
        if (!p.muscle || (this.area && !this.tappable(p.muscle))) p.mesh.material = this.mats.context;
        else {
          const t = this.tint(tints.get(p.muscle) ?? modelColor("muscle"));
          p.mesh.material = p.muscle === this.selected ? t.glow : t.base;
        }
      } else if (p.muscle && p.muscle === this.selected) p.mesh.material = this.mats.highlight;
      else if (this.area && !this.tappable(p.muscle)) p.mesh.material = this.mats.context;
      else p.mesh.material = this.mats.muscle;
    }
  }

  /* ---------------- picking ---------------- */

  /**
   * Draws ids instead of colours for a rectangle of the canvas (CSS px from its top-left) into `target` and reads them
   * into `buffer`: each tappable mesh its app muscle's index + 1, every other mesh SOLID, empty space 0.
   */
  private renderIds(target: WebGLRenderTarget, buffer: Uint8Array, x: number, y: number, w: number, h: number) {
    const r = this.canvas.getBoundingClientRect();
    for (const p of this.model.parts) p.mesh.material = this.tappable(p.muscle) ? this.mats.ids.get(p.muscle)! : this.mats.hidden;
    const background = this.scene.background;
    this.scene.background = null;
    this.camera.setViewOffset(r.width, r.height, x, y, w, h);
    const clear = this.renderer.getClearColor(new Color());
    const alpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.readRenderTargetPixels(target, 0, 0, w, h, buffer);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(clear, alpha);
    this.camera.clearViewOffset();
    this.scene.background = background;
    this.paint();
    this.wake();
  }

  /** The tappable muscle at (or within `radius` px, at most 24, of) a point in client coordinates. */
  pickAt(clientX: number, clientY: number, radius = PICK_RADIUS): Muscle | null {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.round(clientX - r.left);
    const y = Math.round(clientY - r.top);
    this.renderIds(this.pickTarget, this.pickBuffer, x - PICK_RADIUS, y - PICK_RADIUS, PICK_SIZE, PICK_SIZE);
    const ids = [...this.mats.ids.keys()];
    let best: Muscle | null = null;
    let bestD = Infinity;
    for (let row = 0; row < PICK_SIZE; row++)
      for (let col = 0; col < PICK_SIZE; col++) {
        const id = this.pickBuffer[(row * PICK_SIZE + col) * 4];
        if (!id || id === SOLID) continue;
        // Pixel rows are read bottom-up.
        const d = Math.hypot(col - PICK_RADIUS, PICK_SIZE - 1 - row - PICK_RADIUS);
        if (d <= Math.min(radius, PICK_RADIUS) && d < bestD) {
          bestD = d;
          best = ids[id - 1] ?? null;
        }
      }
    return best;
  }

  /** Test hook: how many pixels of a client rectangle the model covers (any mesh, tappable or not). */
  modelPixels(rect: { x: number; y: number; width: number; height: number }): number {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const target = new WebGLRenderTarget(w, h);
    target.texture.colorSpace = NoColorSpace;
    const buffer = new Uint8Array(w * h * 4);
    this.renderIds(target, buffer, Math.round(rect.x - r.left), Math.round(rect.y - r.top), w, h);
    target.dispose();
    let n = 0;
    for (let i = 0; i < buffer.length; i += 4) if (buffer[i]) n++;
    return n;
  }

  /** A tap reports the muscle under it (or null); the picker decides: zoom to its area, or light it up. */
  private tap(clientX: number, clientY: number) {
    this.o.onSelect(this.pickAt(clientX, clientY));
  }

  private onDown = (e: PointerEvent) => {
    if (this.down || !e.isPrimary) this.multi = true;
    else {
      this.multi = false;
      this.down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    }
  };
  private onUp = (e: PointerEvent) => {
    const d = this.down;
    if (d && d.id === e.pointerId) {
      this.down = null;
      if (!this.multi && !this.move && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8 && performance.now() - d.t < 600) this.tap(e.clientX, e.clientY);
    }
  };
  private onCancel = () => {
    this.down = null;
  };
  private onClick = (e: MouseEvent) => {
    // Taps are handled on pointerup; the click only claims the tap for the canvas.
    e.preventDefault();
  };
  // A finger resting on the body draws nothing: frames come from the controls' "change" (a real move) and from their
  // damping, so a tap is not held up by a frame drawn for the touch itself.
  private onStart = () => {
    this.frames = [];
  };
  private onEnd = () => {
    const yaw = this.current().yaw;
    this.o.onFacing(Math.cos(yaw) >= 0 ? "front" : "back");
  };

  /* ---------------- drawing ---------------- */

  private wake = () => {
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(this.tick);
  };

  private tick = (now: number) => {
    this.raf = 0;
    let more = false;
    if (this.move) {
      const t = (now - this.move.start) / this.move.ms;
      this.apply(lerpPose(this.move.from, this.move.to, t));
      if (t >= 1) {
        this.move = null;
        this.controls.enabled = true;
      } else more = true;
    }
    if (this.controls.update()) more = true;
    this.renderNow();
    this.count(now, more);
    if (more) this.wake();
  };

  private renderNow() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Frame times of continuous movement; fps over the latest stretch of at least 500 ms. */
  private count(now: number, more: boolean) {
    this.frames.push(now);
    const span = now - this.frames[0];
    if (span >= 500) this.stats.fps = Math.round(((this.frames.length - 1) * 1000) / span);
    if (!more) this.frames = [];
    else if (this.frames.length > 240) this.frames.shift();
  }

  /** Measurement: turns the body for `ms` and returns the frames per second it drew. */
  spin(ms = 2000): Promise<number> {
    return new Promise((resolve) => {
      const start = performance.now();
      const from = this.current();
      let frames = 0;
      const step = (now: number) => {
        const t = now - start;
        this.apply({ ...from, yaw: from.yaw + (t / 2000) * 2 * Math.PI });
        this.renderNow();
        frames++;
        if (t < ms && !this.disposed) requestAnimationFrame(step);
        else {
          this.apply(from);
          this.renderNow();
          this.stats.fps = Math.round((frames * 1000) / t);
          resolve(this.stats.fps);
        }
      };
      requestAnimationFrame(step);
    });
  }

  /**
   * Test hook: a client point on a model muscle (by base name), not covered by the controls over the stage. With
   * `pickable`, a visible point that a tap would pick as that muscle (null if there is none); without, the first point
   * of the muscle inside the view.
   */
  pointOn(name: string, pickable = true): { x: number; y: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const want = anatomyOf(name)?.muscle ?? null;
    const v = new Vector3();
    for (const p of this.model.parts) {
      if (p.name !== name) continue;
      const pos = p.mesh.geometry.getAttribute("position");
      const step = Math.max(1, Math.floor(pos.count / 60));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(p.mesh.matrixWorld).project(this.camera);
        if (Math.abs(v.x) > 0.9 || Math.abs(v.y) > 0.9 || v.z > 1) continue;
        // Whole pixels, as touch events report them.
        const x = Math.round(r.left + ((v.x + 1) / 2) * r.width);
        const y = Math.round(r.top + ((1 - v.y) / 2) * r.height);
        // Skip points under or next to the controls over the stage (Front / Back, ← Body, the selection bar): a finger
        // there counts as a tap on the control.
        if ([-16, 0, 16].some((dx) => [-16, 0, 16].some((dy) => document.elementFromPoint(x + dx, y + dy) !== this.canvas))) continue;
        if (!pickable) return { x, y };
        // A point at least 2 px inside the muscle, so a tap there picks it even a pixel off.
        if (want && this.interior(x - r.left, y - r.top, want)) return { x, y };
      }
    }
    return null;
  }

  /** Whether the canvas pixel (x, y) and the pixels 2 px around it all show `muscle` (one id render). */
  private interior(x: number, y: number, muscle: Muscle): boolean {
    const id = CANONICAL_MUSCLES.indexOf(muscle) + 1;
    this.renderIds(this.pickTarget, this.pickBuffer, Math.round(x) - PICK_RADIUS, Math.round(y) - PICK_RADIUS, PICK_SIZE, PICK_SIZE);
    // Pixel rows are read bottom-up.
    const at = (dx: number, dy: number) => this.pickBuffer[((PICK_SIZE - 1 - (PICK_RADIUS + dy)) * PICK_SIZE + PICK_RADIUS + dx) * 4];
    return [-2, 0, 2].every((dx) => [-2, 0, 2].every((dy) => at(dx, dy) === id));
  }

  /** Test hook: model names (without the left/right suffix, so a muscle lit on both sides is listed twice) of the meshes drawn highlighted. */
  lit(): string[] {
    const glows = new Set<Material>([this.mats.highlight, ...[...this.tintMats.values()].map((t) => t.glow)]);
    return this.model.parts.filter((p) => glows.has(p.mesh.material as Material)).map((p) => p.name);
  }

  /** Test hook: every muscle mesh with its model name, app muscle (null when unmapped) and the colour it is drawn in. */
  partColors(): { name: string; muscle: Muscle | null; color: string }[] {
    return this.model.parts
      .filter((p) => p.kind === "muscle")
      .map((p) => {
        const m = p.mesh.material as MeshStandardMaterial;
        return { name: p.name, muscle: p.muscle, color: (m.userData.tint as string | undefined) ?? `#${m.color.getHexString()}` };
      });
  }

  /** Test hook: the colour (#rrggbb) an app muscle is drawn in, or "unmapped" for the colour of unmapped muscles. */
  colorOf(muscle: Muscle | "unmapped"): string | null {
    const part = this.model.parts.find((p) => p.kind === "muscle" && (muscle === "unmapped" ? !p.muscle : p.muscle === muscle));
    const m = part?.mesh.material as MeshStandardMaterial | undefined;
    return m ? ((m.userData.tint as string | undefined) ?? `#${m.color.getHexString()}`) : null;
  }

  /** Test hook: whether a Front / Back turn or an area move is still running. */
  moving(): boolean {
    return this.move !== null;
  }

  /** Test hook: the camera's turn around the body, in radians (0 front, π back). */
  yaw(): number {
    return this.current().yaw;
  }

  /** Test hook: GPU objects of this view's renderer. */
  memory() {
    return { ...this.renderer.info.memory, programs: this.renderer.info.programs?.length ?? 0 };
  }

  /** Releases the renderer, its WebGL context, materials, GPU buffers and listeners; keeps the decoded model. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.controls.removeEventListener("change", this.wake);
    this.controls.removeEventListener("start", this.onStart);
    this.controls.removeEventListener("end", this.onEnd);
    this.controls.dispose();
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onCancel);
    this.canvas.removeEventListener("click", this.onClick);
    if (this.model) {
      for (const p of this.model.parts) p.mesh.geometry.dispose();
      this.scene.remove(this.model.root);
    }
    for (const m of [this.mats.muscle, this.mats.context, this.mats.bone, this.mats.highlight, this.mats.hidden, ...this.mats.ids.values()]) m.dispose();
    for (const t of this.tintMats.values()) {
      t.base.dispose();
      t.glow.dispose();
    }
    this.pickTarget.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    hook.live--;
    hook.contexts--;
    if (hook.view === this) hook.view = null;
  }
}
