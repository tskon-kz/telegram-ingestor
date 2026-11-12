import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  loginCode,
  loginPassword,
  loginQrPoll,
  loginQrStart,
  loginResend,
  loginStart,
  type CodeDelivery,
  type CodeDeliveryType,
  type LoginStep,
  type QrView,
} from '../api';
import { ThemeToggle } from '../components/ThemeToggle';

type Mode = 'qr' | 'phone';
type Stage = 'phone' | 'code' | 'password' | 'done';
type Msg = { text: string; kind: 'info' | 'error' | 'ok' };

const QR_POLL_MS = 2000;

const NEXT_TYPE_LABEL: Record<CodeDeliveryType, string> = {
  app: 'via Telegram app',
  sms: 'via SMS',
  call: 'via phone call',
  flash_call: 'via flash call',
  missed_call: 'via missed call',
  email: 'via email',
  fragment: 'via Fragment',
  unknown: 'another way',
};

function deliveryMessage(d: CodeDelivery): string {
  switch (d.type) {
    case 'app':
      return 'Code sent to the "Telegram" service chat in your Telegram app on another device. Not there? Try QR login.';
    case 'sms':
      return 'Code sent via SMS.';
    case 'call':
      return 'You will receive a phone call with the code.';
    case 'flash_call':
    case 'missed_call':
      return 'You will receive a missed call: the code is the last digits of the calling number.';
    case 'email':
      return `Code sent to your login email${d.emailPattern ? ` ${d.emailPattern}` : ''}.`;
    case 'fragment':
      return 'Code sent to your anonymous number on Fragment.';
    default:
      return 'Code sent. Check your Telegram app.';
  }
}

export function Login() {
  const token = useMemo(() => new URLSearchParams(window.location.search).get('t') ?? '', []);
  const [mode, setMode] = useState<Mode>('qr');
  const [stage, setStage] = useState<Stage>('phone');
  const [loginId, setLoginId] = useState<string>('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [delivery, setDelivery] = useState<CodeDelivery | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [qr, setQr] = useState<QrView['qr'] | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);
  const qrLoginId = useRef('');

  const advance = useCallback((step: LoginStep) => {
    if (step === 'password_needed') {
      setStage('password');
      setMsg({ text: 'Enter your 2FA password.', kind: 'info' });
    } else if (step === 'done') {
      setStage('done');
      setMsg({ text: 'Connected! You can close this page and return to the bot.', kind: 'ok' });
    }
  }, []);

  useEffect(() => {
    if (!token || mode !== 'qr' || stage !== 'phone') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const apply = (view: QrView) => {
      if (view.qr) setQr(view.qr);
      if (view.step !== 'qr_pending') {
        setQr(null);
        advance(view.step);
        return false;
      }
      return true;
    };

    const poll = async () => {
      try {
        const view = await loginQrPoll(token, qrLoginId.current);
        if (!stopped && apply(view)) timer = setTimeout(poll, QR_POLL_MS);
      } catch (err) {
        if (!stopped) setMsg({ text: (err as Error).message, kind: 'error' });
      }
    };

    (async () => {
      try {
        setMsg(null);
        const view = await loginQrStart(token);
        if (stopped) return;
        qrLoginId.current = view.loginId;
        setLoginId(view.loginId);
        if (apply(view)) timer = setTimeout(poll, QR_POLL_MS);
      } catch (err) {
        if (!stopped) setMsg({ text: (err as Error).message, kind: 'error' });
      }
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [token, mode, stage, advance]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  if (!token) {
    return (
      <div className="page narrow">
        <div className="notice error">Invalid or expired login link.</div>
      </div>
    );
  }

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

  const applyDelivery = (d: CodeDelivery) => {
    setDelivery(d);
    setResendIn(d.timeout ?? 0);
    setMsg({ text: deliveryMessage(d), kind: 'info' });
  };

  const switchMode = (next: Mode) => {
    if (next === mode || stage === 'done') return;
    setMode(next);
    setStage('phone');
    setQr(null);
    setDelivery(null);
    setMsg(null);
  };

  const onStart = () =>
    run(async () => {
      setMsg({ text: 'Sending code…', kind: 'info' });
      const res = await loginStart(token, phone.trim());
      setLoginId(res.loginId);
      setStage('code');
      applyDelivery(res.delivery);
    });

  const onResend = () =>
    run(async () => {
      setMsg({ text: 'Requesting a new code…', kind: 'info' });
      const res = await loginResend(token, loginId);
      applyDelivery(res.delivery);
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

  const canResend = stage === 'code' && !!delivery?.nextType && resendIn <= 0;
  const resendLabel = delivery?.nextType
    ? `Resend ${NEXT_TYPE_LABEL[delivery.nextType]}`
    : 'Resend';

  return (
    <div className="page narrow">
      <header className="head">
        <h1>Connect your Telegram account</h1>
        <ThemeToggle />
      </header>

      <nav className="tabs">
        <button className={mode === 'qr' ? 'tab active' : 'tab'} onClick={() => switchMode('qr')}>
          QR code
        </button>
        <button
          className={mode === 'phone' ? 'tab active' : 'tab'}
          onClick={() => switchMode('phone')}
        >
          Phone number
        </button>
      </nav>

      {mode === 'qr' ? (
        <fieldset disabled={stage !== 'phone'}>
          <legend>1. Scan QR code</legend>
          <p className="hint">
            On your phone open Telegram → Settings → Devices → Link Desktop Device and scan this
            code. Opened this page on the same phone? Open the link on a computer, or use the phone
            number.
          </p>
          {qr ? (
            <div className="qr" dangerouslySetInnerHTML={{ __html: qr.svg }} />
          ) : (
            stage === 'phone' && <div className="qr qr-placeholder">Loading QR…</div>
          )}
        </fieldset>
      ) : (
        <>
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
              placeholder={delivery?.length ? '0'.repeat(delivery.length) : '12345'}
              inputMode="numeric"
            />
            <div className="row-actions">
              <button onClick={onCode}>Confirm</button>
              {stage === 'code' && delivery?.nextType && (
                <button className="secondary" onClick={onResend} disabled={!canResend}>
                  {resendIn > 0 ? `${resendLabel} (${resendIn}s)` : resendLabel}
                </button>
              )}
            </div>
          </fieldset>
        </>
      )}

      {stage === 'password' && (
        <fieldset disabled={busy}>
          <legend>{mode === 'qr' ? '2' : '3'}. 2FA password</legend>
          <p className="hint">Your account has a cloud password (Two-Step Verification) enabled.</p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Two-step password"
            autoFocus
          />
          <button onClick={onPassword}>Confirm</button>
        </fieldset>
      )}

      {msg && <p className={`notice ${msg.kind}`}>{msg.text}</p>}
    </div>
  );
}
