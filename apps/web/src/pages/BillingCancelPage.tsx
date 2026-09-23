import { Link } from 'react-router-dom';

export function BillingCancelPage() {
  return (
    <div className="billing-status-page">
      <h1>Checkout cancelled</h1>
      <p>No charge was made. You can pick a plan whenever you&apos;re ready.</p>
      <Link to="/pricing" className="primary-button">
        Back to pricing
      </Link>
    </div>
  );
}
