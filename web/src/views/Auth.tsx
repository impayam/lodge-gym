// Setup, login, recovery and re-lock screens (SPEC §4).

import { useState } from "preact/hooks";
import { errorText } from "../api";
import { deviceLabel, localUnlock, loginWithPasskey, recover, registerPasskey } from "../passkey";
import { onLoggedIn, refresh, setState } from "../store";

function Logo() {
  return <img class="gate__logo" src="/icons/icon-192.png" alt="" width={72} height={72} />;
}

/** The error line under a gate's action; always present so a new message is announced. */
const Err = ({ text }: { text: string }) => (
  <p class="ex-card__meta t-orange l-m0" role="alert">
    {text}
  </p>
);

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
      <main class="page gate">
        <Logo />
        <h1 class="h-page">Face ID is set up</h1>
        <p class="ex-card__meta l-m0">These 10 recovery codes are shown only this once. Keep them somewhere safe (a locked note or a password manager). Each code works once.</p>
        <div class="well gate__codes" data-testid="recovery-codes">
          {codes.map((c) => (
            <span>{c}</span>
          ))}
        </div>
        <button
          class="clay press btn-lg t-pink"
          type="button"
          onClick={async () => {
            history.replaceState(null, "", "/");
            await onLoggedIn();
          }}
        >
          I saved the codes, continue
        </button>
      </main>
    );

  return (
    <main class="page gate">
      <Logo />
      <h1 class="h-page">Set up GYM time</h1>
      <p class="ex-card__meta l-m0">Enter the setup code (SETUP_TOKEN) to register Face ID on this device.</p>
      <input
        class="input input--code"
        type="password"
        autoComplete="off"
        aria-label="Setup code"
        placeholder="Setup code"
        value={token}
        onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)}
      />
      <button class="clay press btn-lg t-pink" type="button" disabled={busy || !token.trim()} onClick={submit}>
        Register Face ID
      </button>
      <Err text={err} />
    </main>
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
    <main class="page gate">
      <Logo />
      <h1 class="h-page">GYM time</h1>
      {mode === "login" ? (
        <>
          <button class="clay press btn-lg t-pink" type="button" disabled={busy} onClick={login} data-testid="login">
            Sign in with Face ID
          </button>
          <button class="clay press btn t-muted" type="button" onClick={() => setMode("code")}>
            I can't use my passkey (recovery code)
          </button>
        </>
      ) : (
        <>
          <p class="ex-card__meta l-m0">Enter one of your recovery codes. After that you need to register a new passkey.</p>
          <input
            class="input input--code num"
            autoComplete="off"
            autoCapitalize="characters"
            aria-label="Recovery code"
            placeholder="XXXX-XXXX-XXXX"
            value={code}
            onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)}
          />
          <button class="clay press btn-lg t-pink" type="button" disabled={busy || !code.trim()} onClick={useCode}>
            Continue
          </button>
          <button class="clay press btn t-muted" type="button" onClick={() => setMode("login")}>
            Back to Face ID sign-in
          </button>
        </>
      )}
      <Err text={err} />
    </main>
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
    <main class="page gate">
      <Logo />
      <h1 class="h-page">Register a new passkey</h1>
      <p class="ex-card__meta l-m0">Recovery code accepted. Now register Face ID on this device (you have 15 minutes).</p>
      <button class="clay press btn-lg t-pink" type="button" disabled={busy} onClick={register}>
        Register Face ID
      </button>
      <Err text={err} />
    </main>
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
    <main class="page gate">
      <Logo />
      <h1 class="h-page">Locked</h1>
      <p class="ex-card__meta l-m0">Unlock with Face ID to continue.</p>
      <button class="clay press btn-lg t-pink" type="button" disabled={busy} onClick={unlock}>
        Unlock with Face ID
      </button>
      <Err text={err} />
    </main>
  );
}

export function FirstOffline() {
  return (
    <main class="page gate">
      <Logo />
      <h1 class="h-page">GYM time</h1>
      <p class="ex-card__meta l-m0">The first sign-in on this device needs an internet connection. After that the app also works offline.</p>
      <button class="clay press btn-lg t-pink" type="button" onClick={() => void refresh()}>
        Try again
      </button>
    </main>
  );
}
