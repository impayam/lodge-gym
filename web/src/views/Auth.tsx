// Setup, login, recovery and re-lock screens (SPEC §4).

import { useState } from "preact/hooks";
import { errorText } from "../api";
import { deviceLabel, localUnlock, loginWithPasskey, recover, registerPasskey } from "../passkey";
import { onLoggedIn, refresh, setState } from "../store";

function Logo() {
  return <img class="logo" src="/icons/icon-192.png" alt="" width={72} height={72} />;
}

export function Setup() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await registerPasskey({ setupToken: token.trim(), label: deviceLabel() });
      setCodes(r.recovery_codes ?? []);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (codes)
    return (
      <div class="gate wrap">
        <Logo />
        <h1>Face ID فعال شد</h1>
        <p>این ۱۰ کد بازیابی فقط همین یک بار نشان داده می‌شوند. آن‌ها را جای امنی (مثلاً Notes قفل‌دار یا مدیر رمز) نگه دار. هر کد یک بار کار می‌کند.</p>
        <div class="codes" data-testid="recovery-codes">
          {codes.map((c) => (
            <span>{c}</span>
          ))}
        </div>
        <button
          class="btn btn-primary btn-block"
          type="button"
          onClick={async () => {
            history.replaceState(null, "", "/");
            await onLoggedIn();
          }}
        >
          کدها را ذخیره کردم، ادامه
        </button>
      </div>
    );

  return (
    <div class="gate wrap">
      <Logo />
      <h1>راه‌اندازی Lodge Gym</h1>
      <p>کد راه‌اندازی (SETUP_TOKEN) را وارد کن تا Face ID این دستگاه ثبت شود.</p>
      <input type="password" autoComplete="off" placeholder="کد راه‌اندازی" value={token} onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)} />
      <button class="btn btn-primary btn-block" type="button" disabled={busy || !token.trim()} onClick={submit}>
        ثبت Face ID
      </button>
      <div class="err" role="alert">
        {err}
      </div>
    </div>
  );
}

export function Login() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"login" | "code">("login");
  const [code, setCode] = useState("");

  const login = async () => {
    setBusy(true);
    setErr("");
    try {
      await loginWithPasskey();
      await onLoggedIn();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const useCode = async () => {
    setBusy(true);
    setErr("");
    try {
      await recover(code);
      setState({ auth: "recovery" });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="gate wrap">
      <Logo />
      <h1>Lodge Gym</h1>
      {mode === "login" ? (
        <>
          <button class="btn btn-primary btn-block" type="button" disabled={busy} onClick={login} data-testid="login">
            ورود با Face ID
          </button>
          <button class="linkbtn" type="button" onClick={() => setMode("code")}>
            به passkey دسترسی ندارم (کد بازیابی)
          </button>
        </>
      ) : (
        <>
          <p>یکی از کدهای بازیابی را وارد کن. بعد از آن باید یک passkey تازه ثبت کنی.</p>
          <input autoComplete="off" autoCapitalize="characters" placeholder="XXXX-XXXX-XXXX" class="ltr" value={code} onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)} />
          <button class="btn btn-primary btn-block" type="button" disabled={busy || !code.trim()} onClick={useCode}>
            ادامه
          </button>
          <button class="linkbtn" type="button" onClick={() => setMode("login")}>
            بازگشت به ورود با Face ID
          </button>
        </>
      )}
      <div class="err" role="alert">
        {err}
      </div>
    </div>
  );
}

export function Recovery() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const register = async () => {
    setBusy(true);
    setErr("");
    try {
      await registerPasskey({ label: deviceLabel() });
      await onLoggedIn();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="gate wrap">
      <Logo />
      <h1>ثبت passkey تازه</h1>
      <p>کد بازیابی پذیرفته شد. حالا Face ID این دستگاه را ثبت کن (۱۵ دقیقه فرصت داری).</p>
      <button class="btn btn-primary btn-block" type="button" disabled={busy} onClick={register}>
        ثبت Face ID
      </button>
      <div class="err" role="alert">
        {err}
      </div>
    </div>
  );
}

export function Locked() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const unlock = async () => {
    setBusy(true);
    setErr("");
    try {
      if (navigator.onLine) {
        try {
          await loginWithPasskey();
        } catch (e) {
          if (e instanceof Error && e.message === "network") await localUnlock();
          else throw e;
        }
      } else {
        await localUnlock();
      }
      setState({ auth: "ready" });
      void refresh();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="gate wrap">
      <Logo />
      <h1>قفل است</h1>
      <p>برای ادامه با Face ID باز کن.</p>
      <button class="btn btn-primary btn-block" type="button" disabled={busy} onClick={unlock}>
        باز کردن با Face ID
      </button>
      <div class="err" role="alert">
        {err}
      </div>
    </div>
  );
}

export function FirstOffline() {
  return (
    <div class="gate wrap">
      <Logo />
      <h1>Lodge Gym</h1>
      <p>برای اولین ورود روی این دستگاه به اینترنت نیاز است. بعد از آن برنامه بدون اینترنت هم کار می‌کند.</p>
      <button class="btn btn-primary btn-block" type="button" onClick={() => void refresh()}>
        دوباره امتحان کن
      </button>
    </div>
  );
}
