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
- **S3, two buckets (recommended for an external S3 such as Cloudflare R2):** set `S3_PRIVATE_BUCKET`.
  Every `private/…` key is written to, read from, listed in and deleted from that bucket; everything else
  stays in `S3_BUCKET`. Give `S3_BUCKET` public reads (on R2, a custom domain) and give the private bucket
  no public access at all: it is read only through presigned `GET`s. There is no per-prefix rule to get
  wrong. The bucket is chosen with the same normalized check as below, so `uploads/../private/x` goes to the
  private bucket too.
  - Turning it on for an installation that already has private files: copy `private/` from `S3_BUCKET` to
    the new bucket first (`rclone copy`, `aws s3 sync`), then set the variable and restart. The API does not
    look in the old bucket for a key it cannot find.
  - `GET /health` writes and deletes a test object in both buckets.
  - On R2 with a custom domain (`https://media.example.com/<key>`), also set `S3_PUBLIC_URL` to that domain
    and `S3_PUBLIC_URL_STYLE=domain`: the default `path` style puts the bucket in the address
    (`S3_PUBLIC_URL/<bucket>/<key>`), which only the S3 endpoint itself serves.
- **S3, one bucket (when `S3_PRIVATE_BUCKET` is empty):** a presigned `GET`. The bucket's policy must not
  make `private/` public-read: a bucket-wide public-read policy would still expose it. Limit public reads to
  the prefixes that are meant to be public. The bundled SeaweedFS (`docker/seaweedfs-startup.sh`) does this: anonymous reads only the prefixes in
  `S3_PUBLIC_PREFIXES` (default `uploads transforms cartas juegos media dms`) and refuses to start if
  `private` is listed. A kon that serves public files under another top-level prefix adds it there.
- **Keys are normalized before the check:** `uploads/../private/x`, `.\private\x` and `Private/x` count as
  private, because that is the file the disk opens.

Signed addresses last between 30 seconds and 7 days (one hour by default). Do not store them: ask for a new
one when you need it.
