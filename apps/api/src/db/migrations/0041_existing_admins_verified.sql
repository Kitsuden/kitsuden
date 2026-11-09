-- Existing administrators are not locked out when verification is required
-- ============================================================================
--
-- ── WHY THIS IS NEEDED ─────────────────────────────────────────────────────
--
-- `better-auth` now requires a verified email to sign in with a password
-- (`emailAndPassword.requireEmailVerification: true`). Until now nothing
-- verified anything: the first administrator signing up at `/api/system/setup`
-- created the account with `email_verified = false`, and it stayed that way.
--
-- Measured on a real installation before this change:
--
--     admin | verified=false | has_password=true | users=1
--
-- Deploying verification without this would lock that administrator OUT of their
-- own instance: their password is correct and the response is "Email not
-- verified", for an email that at that moment there may not even be a way
-- to send.
--
-- ── WHY ADMINISTRATORS ONLY ────────────────────────────────────────────────
--
-- Because they are the only ones whose email ownership is implicit: the only way
-- to create an administrator is the initial signup, which only works with ZERO
-- users, so whoever created it is whoever set up the installation. All other
-- users with a password go through normal verification the next time they
-- sign in, with a button to resend the link.
--
-- Marking anyone as verified would be exactly what verification is meant
-- to prevent.
--
-- ── IDEMPOTENT ─────────────────────────────────────────────────────────────
--
-- It only touches unverified rows. On a new installation there are no users and it
-- does nothing; the first administrator's signup already leaves them verified from now on.

UPDATE auth_users
SET email_verified = true
WHERE role = 'admin'
  AND email_verified = false;
