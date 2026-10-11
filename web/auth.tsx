import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, KeyRound, LockKeyhole, LogIn, ShieldCheck, Sparkles } from 'lucide-react';
import type { AuthSession, AuthStatus } from '../shared/team-types';
import {
  ApiError,
  SESSION_EXPIRED_EVENT,
  TOKEN_KEY,
  api,
  post,
  setCsrfToken,
  useAction,
} from './lib';
import { SessionContext } from './session';
import { PENDING_SDK_LINK_KEY, parseSdkExperimentLink } from './deep-links';
import { Badge, Button, ErrorBox, Field, Form, FormActions, Loading } from './ui';
export function AuthBoundary({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const ssoError = new URLSearchParams(location.search).get('auth_error') === 'oidc';
  const [notice, setNotice] = useState('');
  const loadSession = useCallback(async () => {
    try {
      const next = await api<AuthSession>('/auth/session');
      const state = await api<AuthStatus>('/auth/status');
      setStatus(state);
      setCsrfToken(next.csrfToken);
      setSession(next);
      setError('');
      setNotice('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setSession(null);
        setCsrfToken(null);
        sessionStorage.removeItem(TOKEN_KEY);
        setStatus(await api<AuthStatus>('/auth/status'));
      }
      throw e;
    }
  }, []);
  const initialize = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const authStatus = await api<AuthStatus>('/auth/status');
      setStatus(authStatus);
      try {
        await loadSession();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setSession(null);
          setCsrfToken(null);
        } else throw e;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (ssoError) {
        setError(
          'We could not sign you in with SSO. Ask your workspace administrator to check your account and SSO access, then try again.',
        );
        const clean = new URL(location.href);
        clean.searchParams.delete('auth_error');
        history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
      }
      setLoading(false);
    }
  }, [loadSession]);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  useEffect(() => {
    const refresh = () => {
      if (session?.principal.authMethod === 'preman' && document.visibilityState === 'visible')
        void loadSession().catch(() => {});
    };
    addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = setInterval(refresh, 60_000);
    return () => {
      removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      clearInterval(timer);
    };
  }, [session?.principal.authMethod, loadSession]);
  useEffect(() => {
    const expired = () => {
      setSession(null);
      setCsrfToken(null);
      sessionStorage.removeItem(TOKEN_KEY);
      setError('Your session has expired or access was revoked. Sign in again to continue.');
    };
    addEventListener(SESSION_EXPIRED_EVENT, expired);
    return () => removeEventListener(SESSION_EXPIRED_EVENT, expired);
  }, []);
  function endSession(message = '') {
    sessionStorage.removeItem(TOKEN_KEY);
    setCsrfToken(null);
    setSession(null);
    setError('');
    setNotice(message);
  }
  async function signOut() {
    try {
      await post('/auth/logout', {});
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
    }
    endSession();
    if (!status?.enabled) await loadSession();
  }
  if (loading)
    return (
      <div className="auth-loading">
        <Brand />
        <Loading />
      </div>
    );
  if (!status)
    return (
      <div className="auth-loading">
        <Brand />
        <ErrorBox message={error || 'Unable to reach the workspace.'} />
        <Button onClick={() => void initialize()}>Retry connection</Button>
      </div>
    );
  if (!session)
    return (
      <SignIn
        status={status}
        notice={notice}
        initialError={error}
        onSignedIn={async () => {
          await loadSession();
        }}
      />
    );
  return (
    <SessionContext.Provider value={{ session, status, reload: loadSession, signOut, endSession }}>
      <div
        key={`${session.principal.id}:${session.principal.workspaceId}:${session.principal.role}:${session.principal.projectIds?.join(',') ?? '*'}`}
      >
        {children}
      </div>
    </SessionContext.Provider>
  );
}
export function Brand() {
  return (
    <a className="brand" href="#overview" aria-label="Verus home">
      <span className="brand-symbol">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M5 6l7 12 7-12" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
        </svg>
      </span>
      <span>
        verus<span className="brand-period">.</span>
      </span>
    </a>
  );
}
function SignIn({
  status,
  notice,
  initialError,
  onSignedIn,
}: {
  status: AuthStatus;
  notice: string;
  initialError: string;
  onSignedIn: () => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [developer, setDeveloper] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const action = useAction();
  return (
    <div className="auth-page">
      <div className="auth-story">
        <Brand />
        <div className="auth-story-body">
          <div className="eyebrow">YOUR AGENTS. YOUR EVIDENCE.</div>
          <h1>
            A shared standard
            <br />
            for better AI.
          </h1>
          <p>
            Trace what happened. Evaluate what matters.
            <br />
            Give your team the confidence to ship.
          </p>
          <div className="auth-story-diagram" aria-hidden="true">
            <div>
              <span className="auth-diagram-icon">
                <Sparkles size={17} />
              </span>
              <strong>Agent run</strong>
              <span className="auth-diagram-line" />
              <Badge>Traced</Badge>
            </div>
            <div>
              <span className="auth-diagram-icon">
                <ShieldCheck size={17} />
              </span>
              <strong>Evaluation</strong>
              <span className="auth-diagram-line" />
              <Badge tone="green">Verified</Badge>
            </div>
            <div>
              <span className="auth-diagram-icon">
                <LockKeyhole size={17} />
              </span>
              <strong>Workspace</strong>
              <span className="auth-diagram-line" />
              <Badge>Private</Badge>
            </div>
          </div>
        </div>
        <div className="auth-story-footer">
          Verus by PreMan <span>Built around your team’s data.</span>
        </div>
      </div>
      <main className="auth-panel">
        <div className="auth-card">
          <span className="auth-icon">
            <LockKeyhole size={24} />
          </span>
          <div className="eyebrow">WELCOME TO YOUR WORKSPACE</div>
          <h2>{developer ? 'Connect with a token' : 'Continue to Verus'}</h2>
          <p>
            {developer
              ? 'For initial setup and developer access. Regular team members should sign in with their account.'
              : status.preman && !recovery
                ? 'Use your PreMan account and workspace.'
                : 'Use your existing workspace recovery account.'}
          </p>
          <ErrorBox message={action.error || initialError} />
          {notice && <div className="info-banner">{notice}</div>}
          {status.preman && !recovery && (
            <>
              <a className="button primary sso-button" href={status.preman.loginUrl}>
                Continue with PreMan <ArrowRight size={15} />
              </a>
              <button className="text-button" onClick={() => setRecovery(true)}>
                Existing administrator or recovery access
              </button>
            </>
          )}
          {(!status.preman || recovery) && (
            <>
              {!developer && status.oidc && (
                <>
                  <a
                    className="button secondary sso-button"
                    href={status.oidc.loginUrl}
                    onClick={() => {
                      const link = parseSdkExperimentLink(location.pathname);
                      if (link.kind === 'experiment')
                        sessionStorage.setItem(PENDING_SDK_LINK_KEY, link.path);
                    }}
                  >
                    <ShieldCheck size={16} />
                    Continue with {status.oidc.label}
                    <ArrowRight size={15} />
                  </a>
                  <div className="auth-divider">
                    <span />
                    or use your workspace password
                    <span />
                  </div>
                </>
              )}
              {developer ? (
                <Form
                  onSubmit={() =>
                    action.run(async () => {
                      sessionStorage.setItem(TOKEN_KEY, token.trim());
                      try {
                        const s = await api<AuthSession>('/auth/session');
                        if (s.principal.kind === 'bootstrap') location.hash = 'settings';
                        await onSignedIn();
                      } catch (e) {
                        sessionStorage.removeItem(TOKEN_KEY);
                        throw e;
                      }
                    })
                  }
                >
                  <Field
                    label="Administrator token or API key"
                    hint="Your token is kept only for this tab’s session. Never enter a model-provider API key here."
                  >
                    <input
                      type="password"
                      autoComplete="off"
                      autoFocus
                      required
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                  </Field>
                  <FormActions busy={action.busy} label="Connect to workspace" />
                </Form>
              ) : (
                <Form
                  onSubmit={() =>
                    action.run(async () => {
                      sessionStorage.removeItem(TOKEN_KEY);
                      setCsrfToken(null);
                      await post<AuthSession>('/auth/login', { email, password });
                      setPassword('');
                      await onSignedIn();
                    })
                  }
                >
                  <Field label="Work email">
                    <input
                      type="email"
                      autoComplete="username"
                      autoFocus
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@company.com"
                    />
                  </Field>
                  <Field label="Password">
                    <input
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Field>
                  <Button variant="primary" type="submit" disabled={action.busy}>
                    <LogIn size={15} />
                    {action.busy ? 'Signing in…' : 'Sign in'}
                    <ArrowRight size={15} />
                  </Button>
                </Form>
              )}
              <div className="auth-help">
                <p>
                  {developer
                    ? 'First time here? Use the administrator token configured on the server, then create your administrator account under Settings → Team.'
                    : 'Need an account or a password reset? Contact your workspace administrator.'}
                </p>
                <button
                  className="text-button"
                  onClick={() => {
                    action.setError('');
                    setDeveloper((v) => !v);
                  }}
                >
                  <KeyRound size={13} />
                  {developer ? 'Use email and password' : 'Initial setup or developer token'}
                </button>
              </div>
              {status.preman && (
                <button
                  className="text-button"
                  onClick={() => {
                    setRecovery(false);
                    setDeveloper(false);
                  }}
                >
                  Back to PreMan sign-in
                </button>
              )}
            </>
          )}
          <div className="auth-security-note">
            <ShieldCheck size={13} />
            {status.production ? 'Private workspace · secure session' : 'Development workspace'}
          </div>
        </div>
      </main>
    </div>
  );
}
