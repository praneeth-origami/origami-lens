/**
 * One-off ops script: promote/demote a user's platform role directly
 * against the database, for recovery/bootstrap use outside the normal login
 * flow (see authorization/founder-bootstrap.ts for the env-var-driven path
 * that covers the common case). Never exposed as an HTTP endpoint.
 *
 *   pnpm --filter @origami/api exec tsx scripts/set-platform-role.ts <email> <FOUNDER|ADMIN|USER>
 */
import '../src/load-env.js';
import { UserRepository } from '../src/db/user-repository.js';

const VALID_ROLES = ['FOUNDER', 'ADMIN', 'USER'] as const;

async function main(): Promise<void> {
  const [email, role] = process.argv.slice(2);
  if (!email || !role || !(VALID_ROLES as readonly string[]).includes(role)) {
    console.error('Usage: tsx scripts/set-platform-role.ts <email> <FOUNDER|ADMIN|USER>');
    process.exitCode = 1;
    return;
  }

  const userRepo = new UserRepository();
  if (!userRepo.isEnabled()) {
    console.error('DATABASE_URL is not set.');
    process.exitCode = 1;
    return;
  }

  const user = await userRepo.findByEmail(email.trim().toLowerCase());
  if (!user) {
    console.error(`No account found for ${email}.`);
    process.exitCode = 1;
    return;
  }

  const updated = await userRepo.updatePlatformRole(user.id, role as (typeof VALID_ROLES)[number]);
  console.log(`${updated.email ?? updated.id} is now platformRole=${updated.platformRole}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
