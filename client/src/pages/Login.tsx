import { useMemo, useState } from 'react';
import { loginCode, loginPassword, loginStart, type LoginStep } from '../api';
import { ThemeToggle } from '../components/ThemeToggle';

type Stage = 'phone' | 'code' | 'password' | 'done';

export function Login() {
  const token = useMemo(() => new URLSearchParams(window.location.search).get('t') ?? '', []);
  const [stage, setStage] = useState<Stage>('phone');
  const [loginId, setLoginId] = useState<string>('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ text: string; kind: 'info' | 'error' | 'ok' } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <div className="page narrow">
        <div className="notice error">Invalid or expired login link.</div>
      </div>
    );
  }

  const advance = (step: LoginStep) => {
    if (step === 'password_needed') {
      setStage('password');
      setMsg({ text: 'Enter your 2FA password.', kind: 'info' });
    } else if (step === 'done') {
      setStage('done');
      setMsg({ text: 'Connected! You can close this page and return to the bot.', kind: 'ok' });
    }
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setMsg({ text: (err as Error).message, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const onStart = () =>
    run(async () => {
      setMsg({ text: 'Sending code…', kind: 'info' });
      const { loginId: id } = await loginStart(token, phone.trim());
      setLoginId(id);
      setStage('code');
      setMsg({ text: 'Code sent. Check your Telegram app.', kind: 'info' });
    });

  const onCode = () =>
    run(async () => {
      setMsg({ text: 'Verifying…', kind: 'info' });
      const { step } = await loginCode(token, loginId, code.trim());
      advance(step);
    });

  const onPassword = () =>
    run(async () => {
      setMsg({ text: 'Verifying…', kind: 'info' });
      const { step } = await loginPassword(token, loginId, password);
      advance(step);
    });

  return (
    <div className="page narrow">
      <header className="head">
        <h1>Connect your Telegram account</h1>
        <ThemeToggle />
      </header>
      <p className="hint">
        The code is entered here (not in the bot chat) so Telegram does not invalidate it.
      </p>

      <fieldset disabled={stage !== 'phone' || busy}>
        <legend>1. Phone</legend>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1234567890"
          autoComplete="tel"
        />
        <button onClick={onStart}>Send code</button>
      </fieldset>

      <fieldset disabled={stage !== 'code' || busy}>
        <legend>2. Code</legend>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="12345"
          inputMode="numeric"
        />
        <button onClick={onCode}>Confirm</button>
      </fieldset>

      <fieldset disabled={stage !== 'password' || busy}>
        <legend>3. 2FA password</legend>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Two-step password"
        />
        <button onClick={onPassword}>Confirm</button>
      </fieldset>

      {msg && <p className={`notice ${msg.kind}`}>{msg.text}</p>}
    </div>
  );
}
