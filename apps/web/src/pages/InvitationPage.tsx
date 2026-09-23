import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout';
import { useAuth } from '../hooks/useAuth';
import { acceptInvitation, ApiRequestError, fetchInvitationPreview } from '../api/client';
import { lensEvent } from '../notifications/lens-event';
import type { InvitationPreviewResponse } from '@origami/contracts';

type ViewState = 'loading' | 'not-found' | 'expired' | 'revoked' | 'already-accepted' | 'ready' | 'accepting' | 'accepted' | 'error';

/**
 * /invitations/:token — reachable whether or not the visitor is signed in
 * (see App.tsx). Membership is created only after the signed-in user with
 * the matching email explicitly clicks Accept — see workspace-invitation-
 * service.ts's acceptWorkspaceInvitation and the FINAL RULE in the approved
 * spec: receiving this link must never, by itself, grant access.
 */
export function InvitationPage() {
  const { token = '' } = useParams<{ token: string }>();
  const { user, loading: authLoading, logout, refresh } = useAuth();
  const navigate = useNavigate();

  const [state, setState] = useState<ViewState>('loading');
  const [preview, setPreview] = useState<InvitationPreviewResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [acceptedOrgName, setAcceptedOrgName] = useState<string | null>(null);

  useEffect(() => {
    fetchInvitationPreview(token)
      .then((res) => {
        setPreview(res);
        if (res.status === 'NOT_FOUND') setState('not-found');
        else if (res.status === 'EXPIRED') setState('expired');
        else if (res.status === 'REVOKED') setState('revoked');
        else if (res.status === 'ACCEPTED') setState('already-accepted');
        else setState('ready');
      })
      .catch(() => {
        setState('error');
        setErrorMessage('Could not load this invitation. Please try again.');
      });
  }, [token]);

  const from = { pathname: `/invitations/${token}`, search: '' };
  const invitedEmail = preview?.invitedEmail;
  const emailMatches = !!user?.email && !!invitedEmail && user.email.trim().toLowerCase() === invitedEmail.trim().toLowerCase();

  const handleAccept = async () => {
    setState('accepting');
    setErrorMessage(null);
    try {
      const result = await acceptInvitation(token);
      setAcceptedOrgName(result.organizationName);
      await refresh();
      setState('accepted');
      lensEvent.success(`You joined ${result.organizationName} successfully.`);
    } catch (err) {
      setState('error');
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Could not accept this invitation. Please try again.');
    }
  };

  const handleSwitchAccount = async () => {
    await logout();
  };

  let body: React.ReactNode;

  if (state === 'loading' || authLoading) {
    body = <p className="auth-card-subtitle">Loading invitation…</p>;
  } else if (state === 'not-found') {
    body = <p className="auth-error" role="alert">This invitation link is invalid.</p>;
  } else if (state === 'expired') {
    body = <p className="auth-error" role="alert">This invitation has expired. Ask the workspace owner to send a new one.</p>;
  } else if (state === 'revoked') {
    body = <p className="auth-error" role="alert">This invitation has been revoked.</p>;
  } else if (state === 'already-accepted') {
    body = (
      <>
        <p className="auth-success">This invitation has already been accepted.</p>
        {user && (
          <button type="button" className="auth-submit-button" onClick={() => navigate('/', { replace: true })}>
            Go to dashboard
          </button>
        )}
      </>
    );
  } else if (state === 'accepted') {
    body = (
      <>
        <p className="auth-success">You joined {acceptedOrgName ?? preview?.organizationName ?? 'the workspace'}.</p>
        <button type="button" className="auth-submit-button" onClick={() => navigate('/', { replace: true })}>
          Go to dashboard
        </button>
      </>
    );
  } else if (state === 'error') {
    body = <p className="auth-error" role="alert">{errorMessage}</p>;
  } else if (!user) {
    body = (
      <>
        <p className="auth-card-subtitle">Sign in or create an account with {invitedEmail} to accept.</p>
        <div className="auth-form">
          <Link to="/login" state={{ from }} className="auth-submit-button" style={{ textAlign: 'center' }}>
            Sign in
          </Link>
          <Link to="/register" state={{ from }} className="auth-link" style={{ textAlign: 'center', display: 'block', marginTop: '0.75rem' }}>
            Don't have an account? Create one
          </Link>
        </div>
      </>
    );
  } else if (!emailMatches) {
    body = (
      <>
        <p className="auth-error" role="alert">
          This invitation was sent to {invitedEmail}. You are currently signed in as {user.email}.
        </p>
        <button type="button" className="auth-submit-button" onClick={() => void handleSwitchAccount()}>
          Sign out and switch account
        </button>
      </>
    );
  } else if (state === 'accepting') {
    body = <p className="auth-card-subtitle">Accepting invitation…</p>;
  } else {
    body = (
      <>
        {errorMessage && <p className="auth-error" role="alert">{errorMessage}</p>}
        <button type="button" className="auth-submit-button" onClick={() => void handleAccept()}>
          Accept invitation
        </button>
      </>
    );
  }

  return (
    <AuthLayout>
      <div className="auth-card">
        <div>
          <h1>You've been invited</h1>
          {preview && (state === 'ready' || state === 'accepting') && (
            <p className="auth-card-subtitle">
              Join <strong>{preview.organizationName}</strong> as {preview.role}
              {preview.inviterEmail && <> — invited by {preview.inviterEmail}</>}
            </p>
          )}
        </div>
        {body}
      </div>
    </AuthLayout>
  );
}
