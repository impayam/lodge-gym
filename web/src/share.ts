// PNG summary card (canvas) shared through the Web Share API, and CSV download (SPEC §10).

import { NetworkError } from "./api";
import { token } from "./lib/tokens";

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export interface CardLine {
  label: string;
  value: string;
}

/** Draws a 1080×1350 summary card in the --share-* token colors. */
export async function reportCard(title: string, subtitle: string, lines: CardLine[]): Promise<Blob> {
  const color = (name: "bg" | "surface" | "accent" | "muted" | "ink-2" | "ink" | "line") => token(`--share-${name}`);
  const W = 1080;
  const H = 1350;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = color("bg");
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = color("surface");
  roundRect(ctx, 60, 60, W - 120, H - 120, 48);
  ctx.fill();
  ctx.direction = "ltr";
  ctx.textAlign = "left";
  const left = 120;
  const right = W - 120;
  ctx.fillStyle = color("accent");
  ctx.font = `800 64px ${FONT}`;
  ctx.fillText(title, left, 190);
  ctx.fillStyle = color("muted");
  ctx.font = `500 38px ${FONT}`;
  ctx.fillText(subtitle, left, 250);
  let y = 360;
  for (const l of lines.slice(0, 10)) {
    ctx.fillStyle = color("ink-2");
    ctx.font = `500 38px ${FONT}`;
    ctx.textAlign = "left";
    ctx.fillText(l.label, left, y);
    ctx.fillStyle = color("ink");
    ctx.font = `700 44px ${FONT}`;
    ctx.textAlign = "right";
    ctx.fillText(l.value, right, y);
    ctx.strokeStyle = color("line");
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left, y + 30);
    ctx.lineTo(right, y + 30);
    ctx.stroke();
    y += 92;
  }
  ctx.textAlign = "right";
  ctx.fillStyle = color("muted");
  ctx.font = `500 32px ${FONT}`;
  ctx.fillText("GYM time", right, H - 110);
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
