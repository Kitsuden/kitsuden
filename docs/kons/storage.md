# Files in a kon

`ctx.storage` saves, reads, lists and deletes files on the installation's storage (local disk or S3).

## Public and private keys

| Key                                    | Who can read it                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| anything else (`uploads/…`, `media/…`) | anyone with the address: `ctx.storage.publicUrl(key)`                                       |
| `private/…`                            | only through `ctx.storage.getSignedDownloadUrl(key, seconds)`: a short-lived signed address |

Store under `private/` anything that belongs to a person: a customer's voice note, a contract, an invoice.

- **Local disk:** `/media/private/…` answers 404 unless the address carries `exp` and `sig`, an HMAC of the
  key and the expiry with a key derived from `KITSUDEN_SECRETS_KEY` (or `BETTER_AUTH_SECRET`). Served with
  `Cache-Control: private, no-store`.
- **S3:** a presigned `GET`. The bucket's policy must not make `private/` public-read: a bucket-wide
  public-read policy would still expose it. Limit public reads to the prefixes that are meant to be public.

Signed addresses last between 30 seconds and 7 days (one hour by default). Do not store them: ask for a new
one when you need it.
