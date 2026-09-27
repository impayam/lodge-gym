// PNG summary card (canvas) shared through the Web Share API, and CSV download (SPEC §10).

import { toPersianDigits } from "../../worker/lib/digits";
import { NetworkError } from "./api";

export interface CardLine {
  label: string;
  value: string;
}

/** Draws a 1080×1350 summary card in the current theme colors. */
export async function reportCard(title: string, subtitle: string, lines: CardLine[]): Promise<Blob> {
  await Promise.all(["800 64px Vazirmatn", "500 40px Vazirmatn", "700 44px Vazirmatn"].map((f) => document.fonts?.load(f).catch(() => undefined)));
  const css = getComputedStyle(document.documentElement);
  const color = (v: string, fallback: string) => css.getPropertyValue(v).trim() || fallback;
  const W = 1080;
  const H = 1350;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = color("--bg", "#eef1ee");
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = color("--surface", "#ffffff");
  roundRect(ctx, 60, 60, W - 120, H - 120, 48);
  ctx.fill();
  ctx.direction = "rtl";
  ctx.textAlign = "right";
  const right = W - 120;
  ctx.fillStyle = color("--accent", "#0f6e5f");
  ctx.font = "800 64px Vazirmatn, Tahoma, sans-serif";
  ctx.fillText(title, right, 190);
  ctx.fillStyle = color("--muted", "#6f7d77");
  ctx.font = "500 38px Vazirmatn, Tahoma, sans-serif";
  ctx.fillText(subtitle, right, 250);
  let y = 360;
  for (const l of lines.slice(0, 10)) {
    ctx.fillStyle = color("--ink-2", "#4a5752");
    ctx.font = "500 38px Vazirmatn, Tahoma, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(l.label, right, y);
    ctx.fillStyle = color("--ink", "#17211d");
    ctx.font = "700 44px Vazirmatn, Tahoma, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(toPersianDigits(l.value), 120, y);
    ctx.strokeStyle = color("--line", "#d8ded9");
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(120, y + 30);
    ctx.lineTo(right, y + 30);
    ctx.stroke();
    y += 92;
  }
  ctx.textAlign = "left";
  ctx.fillStyle = color("--muted", "#6f7d77");
  ctx.font = "500 32px Vazirmatn, Tahoma, sans-serif";
  ctx.fillText("Lodge Gym", 120, H - 110);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png"));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Shares the file with the Web Share API when possible, otherwise downloads it. Returns what happened. */
export async function shareOrDownload(blob: Blob, filename: string, title: string): Promise<"shared" | "downloaded" | "cancelled"> {
  const file = new File([blob], filename, { type: blob.type });
  if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "downloaded";
}

/** Fetches an authenticated file (CSV/JSON) as a Blob, keeping the server's filename. */
export async function fetchFile(path: string): Promise<{ blob: Blob; filename: string }> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) throw new Error("http_" + res.status);
  const cd = res.headers.get("Content-Disposition") ?? "";
  const filename = cd.match(/filename="([^"]+)"/)?.[1] ?? "lodge-gym.csv";
  return { blob: await res.blob(), filename };
}
