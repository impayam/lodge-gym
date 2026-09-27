// Numeric field with −/+ buttons (press and hold repeats). Accepts Persian/Latin digits and , or . decimals.

import { useEffect, useRef, useState } from "preact/hooks";
import { faNum, parseNumber } from "../../../worker/lib/digits";

interface Props {
  value: number | null;
  placeholder: string;
  step: number;
  onChange: (v: number | null) => void;
  /** Value the buttons start from when the field is empty (e.g. the suggested weight). */
  base: number;
  min?: number;
  decimals?: boolean;
  label: string;
  testId?: string;
}

export function Stepper({ value, placeholder, step, onChange, base, min, decimals = true, label, testId }: Props) {
  const [text, setText] = useState<string | null>(null);
  const repeat = useRef<{ t: ReturnType<typeof setTimeout> | null; fired: boolean }>({ t: null, fired: false });
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => () => stop(), []);

  const clamp = (n: number) => {
    const r = Math.round(n * 100) / 100;
    return min !== undefined ? Math.max(min, r) : r;
  };
  const bump = (dir: 1 | -1) => {
    const next = clamp((latest.current ?? base) + dir * step);
    latest.current = next;
    setText(null);
    onChange(next);
  };
  function stop() {
    if (repeat.current.t) clearTimeout(repeat.current.t);
    repeat.current.t = null;
  }
  const press = (dir: 1 | -1) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    repeat.current.fired = false;
    const loop = (delay: number) => {
      repeat.current.t = setTimeout(() => {
        repeat.current.fired = true;
        bump(dir);
        loop(110);
      }, delay);
    };
    loop(450);
  };
  const click = (dir: 1 | -1) => () => {
    stop();
    if (repeat.current.fired) {
      repeat.current.fired = false;
      return;
    }
    bump(dir);
  };

  const shown = text ?? (value == null ? "" : faNum(value));
  return (
    <div class="stepper" data-testid={testId}>
      <button type="button" aria-label={`کم کردن ${label}`} onPointerDown={press(-1)} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop} onClick={click(-1)}>
        −
      </button>
      <input
        inputMode={min !== undefined && min >= 0 ? (decimals ? "decimal" : "numeric") : "text"}
        enterKeyHint="done"
        autoComplete="off"
        aria-label={label}
        placeholder={placeholder}
        value={shown}
        onFocus={(e) => setText((e.currentTarget as HTMLInputElement).value)}
        onBlur={() => setText(null)}
        onInput={(e) => {
          const raw = (e.currentTarget as HTMLInputElement).value;
          setText(raw);
          if (raw.trim() === "") return onChange(null);
          const n = parseNumber(raw);
          if (n !== null && (decimals || Number.isInteger(n)) && (min === undefined || n >= min)) onChange(n);
        }}
      />
      <button type="button" aria-label={`زیاد کردن ${label}`} onPointerDown={press(1)} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop} onClick={click(1)}>
        +
      </button>
    </div>
  );
}
