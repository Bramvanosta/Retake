import { useEffect, useState } from 'react';
import { api } from '../../shared/api.js';
import { Icon, LogoMark } from '../../shared/icons.jsx';
import { Link, useLocation } from '../../shared/router.jsx';

/** "Open a café account": a short form; the server sends a confirmation email (fixture mailbox, Mailpit API). */
export function SignupPage() {
  const [cafe, setCafe] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ready = cafe.trim() && name.trim() && /.+@.+\..+/.test(email);

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      setSent(await api.post('/api/signup', { cafe, name, email }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signup">
      <div className="signup-card card">
        <div className="signup-brand">
          <LogoMark size={40} />
          <div>
            <div className="signup-kicker">Northfield for cafés</div>
            <h1 className="signup-title">{sent ? 'Check your inbox' : 'Open a café account'}</h1>
          </div>
        </div>
        {sent ? (
          <div className="signup-sent" role="status">
            <span className="signup-sent-icon">
              <Icon name="check" size={22} strokeWidth={2.4} />
            </span>
            <p>
              We sent a confirmation link to <b>{sent.email}</b>. Open it to start requesting quotes for <b>{sent.cafe}</b>.
            </p>
          </div>
        ) : (
          <form className="signup-form" onSubmit={submit}>
            <p className="muted signup-lede">Request quotes from specialty roasters, follow every proposal and order in one place.</p>
            <label className="field">
              <span className="field-label">Café name</span>
              <input className="input" value={cafe} onChange={(e) => setCafe(e.target.value)} placeholder="e.g. Café Lumen" />
            </label>
            <label className="field">
              <span className="field-label">Your name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="First and last name" />
            </label>
            <label className="field">
              <span className="field-label">Work email</span>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@your-cafe.com" />
            </label>
            {error ? <p className="signup-error">{error}</p> : null}
            <button type="submit" className="btn btn-primary btn-lg" disabled={!ready || busy}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
            <p className="field-hint">We send a link to confirm your email. No card needed.</p>
          </form>
        )}
      </div>
    </div>
  );
}

/** The confirmation link of the email (`?token=`; "latest" confirms the most recent signup — a fixture convenience). */
export function SignupConfirmPage() {
  const { search } = useLocation();
  const token = search.get('token') ?? 'latest';
  const [state, setState] = useState({ status: 'loading' });
  useEffect(() => {
    api
      .post('/api/signup/confirm', { token })
      .then((s) => setState({ status: 'ok', signup: s }))
      .catch((err) => setState({ status: 'error', message: err.message }));
  }, [token]);
  return (
    <div className="signup">
      <div className="signup-card card">
        <div className="signup-brand">
          <LogoMark size={40} />
          <div>
            <div className="signup-kicker">Northfield for cafés</div>
            <h1 className="signup-title">
              {state.status === 'ok' ? `Welcome, ${state.signup.cafe}` : state.status === 'error' ? 'Link expired' : 'Confirming…'}
            </h1>
          </div>
        </div>
        {state.status === 'ok' ? (
          <div className="signup-sent" role="status">
            <span className="signup-sent-icon">
              <Icon name="check" size={22} strokeWidth={2.4} />
            </span>
            <p>
              Your email <b>{state.signup.email}</b> is confirmed. Your café account is ready: request your first quote.
            </p>
          </div>
        ) : null}
        {state.status === 'error' ? <p className="signup-error">{state.message}</p> : null}
        {state.status === 'ok' ? (
          <Link className="btn btn-primary btn-lg" to="/coffees">
            Browse coffees
          </Link>
        ) : null}
      </div>
    </div>
  );
}
