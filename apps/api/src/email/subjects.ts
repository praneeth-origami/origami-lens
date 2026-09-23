/**
 * Every template's subject line, centralized so a subject is never
 * duplicated or drifted between the sender in email-service.ts and a
 * template's own render function. Values are plain strings (no HTML
 * escaping needed — nodemailer encodes the `subject` header safely) or a
 * function of the minimal data needed to interpolate it.
 */
export const EMAIL_SUBJECTS = {
  workspaceInvitation: (workspaceName: string) => `You're invited to join ${workspaceName} on Origami Lens`,
  passwordReset: 'Reset your Origami Lens password',
  passwordChanged: 'Your Origami Lens password was changed',
  emailVerification: 'Verify your Origami Lens email address',
  workspaceMemberAdded: (workspaceName: string) => `You've joined ${workspaceName} on Origami Lens`,
  workspaceMemberRemoved: (workspaceName: string) => `You've been removed from ${workspaceName}`,
  repositoryConnected: (repoName: string) => `${repoName} is connected to Origami Lens`,
  repositoryIndexCompleted: (repoName: string) => `${repoName} is ready to search`,
  repositoryIndexFailed: (repoName: string) => `Indexing failed for ${repoName}`,
  pullRequestCreated: (repoName: string) => `Pull request opened for ${repoName}`,
  billingSubscriptionStarted: (plan: string) => `Your ${plan} subscription is active`,
  billingPlanExpiringSoon: (plan: string) => `Your ${plan} plan ends soon`,
  billingPaymentSuccessful: 'Your Origami Lens payment was successful',
  billingPaymentFailed: 'Action needed: your Origami Lens payment failed',
  billingPlanLimitReached: 'You have reached your plan limit',
  billingSubscriptionCancelled: 'Your Origami Lens subscription was cancelled',
} as const;
