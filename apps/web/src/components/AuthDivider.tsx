export function AuthDivider({ label = 'or continue with email' }: { label?: string }) {
  return <div className="auth-divider">{label}</div>;
}
