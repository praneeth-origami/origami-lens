import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { OrganizationRole, WorkspaceInvitation, WorkspaceMember } from '@origami/contracts';
import { useAuth } from '../hooks/useAuth';
import { useWorkspaceRole } from '../hooks/useWorkspaceRole';
import { canManageMembers, canTransferOwnership } from '../utils/workspace-permissions';
import {
  fetchWorkspaceMembers,
  updateWorkspaceMemberRole,
  removeWorkspaceMember,
  transferWorkspaceOwnership,
  createWorkspaceInvitation,
  fetchWorkspaceInvitations,
  revokeWorkspaceInvitation,
  resendWorkspaceInvitation,
  ApiRequestError,
} from '../api/client';
import { lensEvent } from '../notifications/lens-event';
import { confirm } from '../notifications/confirm';
import { MailIcon, UsersIcon, ShieldIcon, UserIcon, EyeIcon, LockIcon, CrownIcon, MoreIcon, UserPlusIcon, ChevronDownIcon } from '../components/icons';

const ASSIGNABLE_ROLES: OrganizationRole[] = ['ADMIN', 'MEMBER', 'VIEWER', 'CLIENT_VIEWER'];

/** Icon + label + a one-line description derived from the real backend permission predicates (apps/api/src/authorization/workspace-permissions.ts) — never claims a role can do more than it actually can. */
const ROLE_META: Record<OrganizationRole, { icon: ComponentType; label: string; description: string }> = {
  OWNER: { icon: CrownIcon, label: 'Owner', description: 'Full control, including billing and ownership transfer.' },
  ADMIN: { icon: ShieldIcon, label: 'Admin', description: 'Can manage members, repositories, and scans.' },
  MEMBER: { icon: UserIcon, label: 'Member', description: 'Can run scans and use AI features.' },
  VIEWER: { icon: EyeIcon, label: 'Viewer', description: 'Can view workspace content.' },
  CLIENT_VIEWER: { icon: LockIcon, label: 'Client viewer', description: 'Limited access — reserved for future client sharing.' },
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function expiresLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const hours = Math.floor(ms / 3600000);
  if (hours < 24) return `in ${Math.max(hours, 1)}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

function formatJoined(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Custom role picker — replaces the native <select> so each option can show
 * an icon + description (spec's explicit ask). Portal-based: this page's
 * root uses `.animate-in` (a CSS animation), which — a real bug caught
 * building the Report feature's dropdowns earlier this session — traps
 * position:absolute/fixed descendants beneath later sections. Same click-
 * outside/Escape/focus-return pattern as TopNav.tsx's ProfileMenu.
 */
function RoleSelect({ value, onChange, disabled }: { value: OrganizationRole; onChange: (role: OrganizationRole) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const updatePosition = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, left: rect.left, width: Math.max(rect.width, 230) });
    };
    updatePosition();
    const handleLayoutChange = () => setOpen(false);
    window.addEventListener('scroll', handleLayoutChange, true);
    window.addEventListener('resize', handleLayoutChange);
    return () => {
      window.removeEventListener('scroll', handleLayoutChange, true);
      window.removeEventListener('resize', handleLayoutChange);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const meta = ROLE_META[value];
  const Icon = meta.icon;

  return (
    <div className="role-select-container" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="role-select-trigger"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="role-select-icon" aria-hidden="true"><Icon /></span>
        <span>{meta.label}</span>
        <ChevronDownIcon />
      </button>

      {open && position &&
        createPortal(
          <div
            ref={menuRef}
            className="role-select-menu"
            role="listbox"
            aria-label="Select a role"
            style={{ position: 'fixed', top: position.top, left: position.left, minWidth: position.width }}
          >
            {ASSIGNABLE_ROLES.map((r) => {
              const m = ROLE_META[r];
              const OptionIcon = m.icon;
              return (
                <button
                  key={r}
                  type="button"
                  role="option"
                  aria-selected={r === value}
                  className={`role-select-option ${r === value ? 'active' : ''}`}
                  onClick={() => {
                    onChange(r);
                    setOpen(false);
                  }}
                >
                  <span className="role-select-option-icon" aria-hidden="true"><OptionIcon /></span>
                  <span className="role-select-option-copy">
                    <span className="role-select-option-label">{m.label}</span>
                    <span className="role-select-option-description">{m.description}</span>
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

interface ActionItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/** Generic portal-based "•••" menu — no new capability, just relocates the existing inline buttons (Remove/Make owner, Resend/Revoke) behind one trigger. Same portal/positioning approach as RoleSelect above. */
function ActionsMenu({ items, ariaLabel, busy }: { items: ActionItem[]; ariaLabel: string; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const updatePosition = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    };
    updatePosition();
    const handleLayoutChange = () => setOpen(false);
    window.addEventListener('scroll', handleLayoutChange, true);
    window.addEventListener('resize', handleLayoutChange);
    return () => {
      window.removeEventListener('scroll', handleLayoutChange, true);
      window.removeEventListener('resize', handleLayoutChange);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="member-actions-menu-container" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="member-actions-trigger"
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <MoreIcon />
      </button>

      {open && position &&
        createPortal(
          <div ref={menuRef} className="member-actions-menu" role="menu" aria-label={ariaLabel} style={{ position: 'fixed', top: position.top, right: position.right }}>
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`member-actions-menu-item ${item.destructive ? 'destructive' : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function WorkspaceMembersPage() {
  const { user } = useAuth();
  const { role, loading: roleLoading } = useWorkspaceRole();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<OrganizationRole>('MEMBER');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [busyInvitationId, setBusyInvitationId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'members' | 'invitations'>('members');
  const [search, setSearch] = useState('');

  const canManage = canManageMembers(role);
  const canTransfer = canTransferOwnership(role);
  const showingMembers = !canManage || activeTab === 'members';

  const load = () => {
    setLoading(true);
    setError(null);
    fetchWorkspaceMembers()
      .then((res) => setMembers(res.members))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load members'))
      .finally(() => setLoading(false));
  };

  const loadInvitations = () => {
    if (!canManage) return;
    fetchWorkspaceInvitations()
      .then((res) => setInvitations(res.invitations.filter((i) => i.status === 'PENDING')))
      .catch(() => {});
  };

  useEffect(load, []);
  useEffect(loadInvitations, [canManage]);

  const handleInvite = async (event: FormEvent) => {
    event.preventDefault();
    setInviteError(null);
    setInviting(true);
    try {
      const sentTo = email.trim();
      const { emailDelivered } = await createWorkspaceInvitation({ email: sentTo, role: newRole });
      setEmail('');
      if (emailDelivered) {
        lensEvent.success('Invitation sent', { resource: sentTo, detail: newRole, icon: <MailIcon /> });
      } else {
        lensEvent.warning('Invitation created', { resource: sentTo, detail: 'The email could not be sent — you can resend it below.' });
      }
      loadInvitations();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'MULTI_MEMBER_NOT_SUPPORTED_ON_PLAN') {
        setInviteError('Your plan does not support multiple workspace members. Upgrade to Team to add teammates.');
      } else if (err instanceof ApiRequestError && err.code === 'MEMBER_ALREADY_EXISTS') {
        setInviteError('This person is already a member of this workspace.');
      } else if (err instanceof ApiRequestError && err.code === 'INVALID_EMAIL') {
        setInviteError('Enter a valid email address.');
      } else {
        setInviteError(err instanceof Error ? err.message : 'Could not send invitation.');
      }
    } finally {
      setInviting(false);
    }
  };

  const handleRevoke = async (invitationId: string) => {
    const confirmed = await confirm({
      title: 'Revoke invitation?',
      description: 'The invitation link will stop working immediately.',
      confirmText: 'Revoke invitation',
      destructive: true,
    });
    if (!confirmed) return;
    setBusyInvitationId(invitationId);
    try {
      await revokeWorkspaceInvitation(invitationId);
      lensEvent.success('Invitation revoked successfully.');
      loadInvitations();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Could not revoke invitation.');
    } finally {
      setBusyInvitationId(null);
    }
  };

  const handleResend = async (invitationId: string) => {
    setBusyInvitationId(invitationId);
    try {
      const { emailDelivered } = await resendWorkspaceInvitation(invitationId);
      if (emailDelivered) {
        lensEvent.success('Invitation resent successfully.');
      } else {
        lensEvent.warning('Could not send the email — try again shortly.');
      }
      loadInvitations();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Could not resend invitation.');
    } finally {
      setBusyInvitationId(null);
    }
  };

  const handleRoleChange = async (userId: string, memberRole: OrganizationRole) => {
    setBusyUserId(userId);
    try {
      await updateWorkspaceMemberRole(userId, { role: memberRole });
      lensEvent.success('Member role updated successfully.');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update role.');
    } finally {
      setBusyUserId(null);
    }
  };

  const handleRemove = async (userId: string) => {
    const confirmed = await confirm({
      title: 'Remove member?',
      description: 'They will immediately lose access to this workspace.',
      confirmText: 'Remove member',
      destructive: true,
    });
    if (!confirmed) return;
    setBusyUserId(userId);
    try {
      await removeWorkspaceMember(userId);
      lensEvent.success('Member removed successfully.');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove member.');
    } finally {
      setBusyUserId(null);
    }
  };

  const handleTransfer = async (userId: string) => {
    const confirmed = await confirm({
      title: 'Transfer ownership?',
      description: 'You will become an admin and this member will become the new workspace owner.',
      confirmText: 'Transfer ownership',
      destructive: true,
    });
    if (!confirmed) return;
    setBusyUserId(userId);
    try {
      await transferWorkspaceOwnership({ newOwnerUserId: userId });
      lensEvent.success('Workspace ownership transferred successfully.');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not transfer ownership.');
    } finally {
      setBusyUserId(null);
    }
  };

  if (loading || roleLoading) {
    return (
      <div className="list-page animate-in">
        <div className="workspace-skeleton-header" />
        <div className="workspace-skeleton-card" />
        <div className="workspace-skeleton-table">
          {[0, 1, 2].map((i) => <div key={i} className="workspace-skeleton-row" />)}
        </div>
      </div>
    );
  }

  const filteredMembers = search.trim()
    ? members.filter((m) => {
        const q = search.trim().toLowerCase();
        return (m.displayName ?? '').toLowerCase().includes(q) || (m.email ?? '').toLowerCase().includes(q);
      })
    : members;

  return (
    <div className="list-page animate-in">
      <div className="page-heading-row workspace-heading-row">
        <div>
          <div className="page-eyebrow"><UsersIcon /> Workspace</div>
          <h1 className="page-title">Workspace members</h1>
          <p className="page-subtitle">Manage who has access to this workspace and what they can do.</p>
        </div>
        <div className="workspace-header-card">
          <span className="workspace-header-card-icon" aria-hidden="true"><UsersIcon /></span>
          <div>
            <div className="workspace-header-card-title">Stronger together</div>
            <div className="workspace-header-card-subtitle">Invite your team and ship better websites.</div>
          </div>
        </div>
      </div>

      {error && <p className="billing-status-note" role="alert">{error}</p>}

      {canManage ? (
        <div className="invite-member-card">
          <div className="invite-member-card-header">
            <span className="invite-member-card-icon" aria-hidden="true"><UserPlusIcon /></span>
            <div>
              <h2>Invite a new member</h2>
              <p>Add your team members to collaborate on scans, repositories and fixes.</p>
            </div>
          </div>
          <form className="workspace-add-member-form" onSubmit={handleInvite}>
            <div className="invite-email-field">
              <span className="invite-email-icon" aria-hidden="true"><MailIcon /></span>
              <input
                type="email"
                required
                placeholder="teammate@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-label="Email address"
              />
            </div>
            <RoleSelect value={newRole} onChange={setNewRole} />
            <button type="submit" className="primary-button invite-submit-button" disabled={inviting}>
              {inviting ? 'Sending invitation…' : 'Send invitation'}
            </button>
          </form>
          <p className="invite-help-text">They'll receive an email invitation to join this workspace.</p>
        </div>
      ) : (
        <div className="invite-member-card invite-member-card-readonly">
          <span className="invite-member-card-icon" aria-hidden="true"><LockIcon /></span>
          <div>
            <h2>You can view this workspace</h2>
            <p>Only workspace owners and admins can invite or manage members.</p>
          </div>
        </div>
      )}
      {inviteError && <p className="billing-status-note" role="alert">{inviteError}</p>}

      <div className="workspace-toolbar">
        {canManage && (
          <div className="workspace-tabs" role="tablist" aria-label="Workspace sections">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'members'}
              className={`workspace-tab ${activeTab === 'members' ? 'active' : ''}`}
              onClick={() => setActiveTab('members')}
            >
              <UsersIcon /> Members <span className="workspace-tab-count">{members.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'invitations'}
              className={`workspace-tab ${activeTab === 'invitations' ? 'active' : ''}`}
              onClick={() => setActiveTab('invitations')}
            >
              <MailIcon /> Pending invitations <span className="workspace-tab-count">{invitations.length}</span>
            </button>
          </div>
        )}
        {showingMembers && (
          <div className="list-page-search">
            <input
              type="text"
              className="search-input"
              placeholder="Search members…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search members"
            />
          </div>
        )}
      </div>

      {showingMembers && (
        <div className="record-table-wrap">
          <table className="record-table workspace-members-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Joined</th>
                {canManage && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {filteredMembers.map((member) => {
                const meta = ROLE_META[member.role];
                const RoleIcon = meta.icon;
                const initial = (member.displayName ?? member.email ?? '?').charAt(0).toUpperCase();
                const isSelf = member.userId === user?.id;
                const items: ActionItem[] = [];
                if (canManage && member.role !== 'OWNER' && !isSelf) {
                  items.push({ label: 'Remove member', destructive: true, disabled: busyUserId === member.userId, onClick: () => void handleRemove(member.userId) });
                }
                if (canTransfer && member.role !== 'OWNER') {
                  items.push({ label: 'Make owner', disabled: busyUserId === member.userId, onClick: () => void handleTransfer(member.userId) });
                }
                return (
                  <tr key={member.userId}>
                    <td data-label="Member">
                      <div className="member-identity">
                        <span className="member-avatar" aria-hidden="true">{initial}</span>
                        <div>
                          <span className="record-primary">
                            {member.displayName ?? member.email ?? member.userId}
                            {isSelf && <span className="you-badge">You</span>}
                          </span>
                          {member.email && <span className="record-secondary">{member.email}</span>}
                        </div>
                      </div>
                    </td>
                    <td data-label="Role">
                      {canManage && member.role !== 'OWNER' ? (
                        <RoleSelect value={member.role} disabled={busyUserId === member.userId} onChange={(r) => void handleRoleChange(member.userId, r)} />
                      ) : (
                        <span className={`badge role-badge role-${member.role.toLowerCase()}`}>
                          <RoleIcon /> {meta.label}
                        </span>
                      )}
                    </td>
                    <td data-label="Joined">{formatJoined(member.joinedAt)}</td>
                    {canManage && (
                      <td data-label={items.length > 0 ? 'Actions' : undefined} className="workspace-member-actions-cell">
                        <ActionsMenu items={items} ariaLabel={`Actions for ${member.displayName ?? member.email ?? 'this member'}`} busy={busyUserId === member.userId} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canManage && activeTab === 'invitations' && (
        <>
          {invitations.length === 0 ? (
            <div className="empty-state-card">
              <span className="empty-state-icon" aria-hidden="true"><MailIcon /></span>
              <h3>No pending invitations</h3>
              <p>When you invite new members, they'll appear here until they accept.</p>
            </div>
          ) : (
            <div className="record-table-wrap">
              <table className="record-table workspace-invitations-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Sent</th>
                    <th>Expires</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invitation) => {
                    const meta = ROLE_META[invitation.role];
                    const RoleIcon = meta.icon;
                    const items: ActionItem[] = [
                      { label: 'Resend invitation', disabled: busyInvitationId === invitation.id, onClick: () => void handleResend(invitation.id) },
                      { label: 'Revoke invitation', destructive: true, disabled: busyInvitationId === invitation.id, onClick: () => void handleRevoke(invitation.id) },
                    ];
                    return (
                      <tr key={invitation.id}>
                        <td data-label="Email">{invitation.invitedEmail}</td>
                        <td data-label="Role">
                          <span className={`badge role-badge role-${invitation.role.toLowerCase()}`}>
                            <RoleIcon /> {meta.label}
                          </span>
                        </td>
                        <td data-label="Sent">{timeAgo(invitation.createdAt)}</td>
                        <td data-label="Expires">{expiresLabel(invitation.expiresAt)}</td>
                        <td data-label="Actions">
                          <ActionsMenu items={items} ariaLabel={`Actions for invitation to ${invitation.invitedEmail}`} busy={busyInvitationId === invitation.id} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
