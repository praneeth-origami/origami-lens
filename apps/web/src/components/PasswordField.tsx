import { useId, useState } from 'react';
import { EyeIcon, EyeOffIcon, LockIcon } from './icons';

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
}

/** Show/hide toggle, matching the reference design's password field — shared by LoginPage/RegisterPage/ResetPasswordPage so the interaction (and its accessible label) is identical everywhere a password is entered. */
export function PasswordField({ label, value, onChange, placeholder = 'Enter your password', autoComplete = 'current-password', required = true }: Props) {
  const [visible, setVisible] = useState(false);
  const id = useId();

  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-input-wrap">
        <span className="auth-input-icon"><LockIcon /></span>
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          className="auth-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
        />
        <button
          type="button"
          className="auth-password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    </div>
  );
}
