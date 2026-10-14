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
        <h1>Face ID is set up</h1>
        <p>These 10 recovery codes are shown only this once. Keep them somewhere safe (a locked note or a password manager). Each code works once.</p>
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
          I saved the codes, continue
        </button>
      </div>
    );

  return (
    <div class="gate wrap">
      <Logo />
      <h1>Set up GYM time</h1>
      <p>Enter the setup code (SETUP_TOKEN) to register Face ID on this device.</p>
      <input type="password" autoComplete="off" placeholder="Setup code" value={token} onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)} />
      <button class="btn btn-primary btn-block" type="button" disabled={busy || !token.trim()} onClick={submit}>
        Register Face ID
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
      <h1>GYM time</h1>
      {mode === "login" ? (
        <>
          <button class="btn btn-primary btn-block" type="button" disabled={busy} onClick={login} data-testid="login">
            Sign in with Face ID
          </button>
          <button class="linkbtn" type="button" onClick={() => setMode("code")}>
            I can't use my passkey (recovery code)
          </button>
        </>
      ) : (
        <>
          <p>Enter one of your recovery codes. After that you need to register a new passkey.</p>
          <input autoComplete="off" autoCapitalize="characters" placeholder="XXXX-XXXX-XXXX" value={code} onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)} />
          <button class="btn btn-primary btn-block" type="button" disabled={busy || !code.trim()} onClick={useCode}>
            Continue
          </button>
          <button class="linkbtn" type="button" onClick={() => setMode("login")}>
            Back to Face ID sign-in
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
      <h1>Register a new passkey</h1>
      <p>Recovery code accepted. Now register Face ID on this device (you have 15 minutes).</p>
      <button class="btn btn-primary btn-block" type="button" disabled={busy} onClick={register}>
        Register Face ID
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
      <h1>Locked</h1>
      <p>Unlock with Face ID to continue.</p>
      <button class="btn btn-primary btn-block" type="button" disabled={busy} onClick={unlock}>
        Unlock with Face ID
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
      <h1>GYM time</h1>
      <p>The first sign-in on this device needs an internet connection. After that the app also works offline.</p>
      <button class="btn btn-primary btn-block" type="button" onClick={() => void refresh()}>
        Try again
      </button>
    </div>
  );
}
