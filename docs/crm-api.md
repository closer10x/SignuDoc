# CRM API

A server-to-server API for creating envelopes, checking them, and downloading the sealed PDF. It is aimed at another system you run, such as a CRM, that needs to send a document for signature.

Envelopes created here are ordinary envelopes. They show on the dashboard of the longest-standing administrator, and they keep the same audit trail, consent step, seal, and email as envelopes sent from the app. The organization's name, logo, and color come from Settings. Nothing in the API sets those.

Leave `SIGNUDOC_API_KEY` unset and every call is refused.

## Setup

Generate two secrets and set them on the deployment (on Vercel: Settings, Environment Variables, then redeploy):

```bash
openssl rand -hex 32
```

| Variable                  | Purpose                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `SIGNUDOC_API_KEY`        | Sent as `Authorization: Bearer …` on every call. Compared in constant time. A missing or wrong token is `401`. |
| `SIGNUDOC_WEBHOOK_SECRET` | Signs webhook bodies with HMAC-SHA256. Required before a request may set `callbackUrl`.                        |

The API is served on the same host as the app. The examples use `https://sign.example`.

Calls answer with JSON except the two downloads, which stream a PDF. Errors look like `{ "error": "…" }` with an HTTP status. `401` means the API key was missing or wrong. `404` means the envelope does not exist, or a download was asked for before the envelope was completed.

## Create an envelope

`POST /api/v1/envelopes`

Send either:

- `multipart/form-data` with the PDF in the `file` field and the rest as form fields (JSON for `signers`, `cc`, and `fields`), or a single `payload` JSON field plus `file`
- `application/json` with the PDF in `pdf` as base64

On Vercel a function request cannot be larger than 4.5 MB, so a large PDF needs to stay under that limit.

| Field           | Required |                                                                                                                                                     |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`         | yes      | Shown to signers and on the dashboard.                                                                                                              |
| `signers`       | yes      | `[{ "name", "email", "order" }]`. `order` is the signing order, starting at 1. Leave it off and the array order is used. Each address is used once. |
| `file` or `pdf` | yes      | The PDF.                                                                                                                                            |
| `filename`      | no       | Defaults to the uploaded name, or `document.pdf`. Must end in `.pdf`.                                                                               |
| `message`       | no       | A note added to the signing invitation. Without it, the invitation is the same one the app sends.                                                   |
| `cc`            | no       | `[{ "name", "email" }]`. They receive the finished document and do not sign. `name` defaults to the part of the address before `@`.                 |
| `fields`        | no       | See below. With none, each signer gets a signature and a date on the last page.                                                                     |
| `externalId`    | no       | Your own id, stored and sent back on webhooks. A CRM lead id, for example.                                                                          |
| `callbackUrl`   | no       | `https` URL that receives status changes. `http` is accepted only for localhost.                                                                    |
| `send`          | no       | `true` emails the first signer. `false` (the default) leaves a draft.                                                                               |

A field is `{ "type", "signerIndex", "page", "x", "y", "width", "height", "required" }`.

- `type` is `signature`, `initials`, `date`, `text`, or `checkbox`. Signature, initials, and date are always required.
- `signerIndex` is the index in the `signers` array you sent, starting at 0.
- `page` starts at 1.
- `x`, `y`, `width`, and `height` are fractions of the page from the top left when every value is between 0 and 1. If any value is greater than 1, all four are points from the top left (y grows downward).

Signers sign in order. The response includes a URL only for the signer whose turn it is. The next signer is emailed when the previous one finishes, the same way as in the app.

```bash
curl -sS -X POST https://sign.example/api/v1/envelopes \
  -H "Authorization: Bearer $SIGNUDOC_API_KEY" \
  -F file=@agreement.pdf \
  -F title="Fleet application" \
  -F message="Please sign the application." \
  -F externalId="lead-1042" \
  -F callbackUrl="https://crm.example/signudoc" \
  -F send=true \
  -F 'signers=[{"name":"Riley Signer","email":"riley@example.com","order":1}]'
```

The same call as JSON:

```bash
curl -sS -X POST https://sign.example/api/v1/envelopes \
  -H "Authorization: Bearer $SIGNUDOC_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"Fleet application\",
    \"message\": \"Please sign the application.\",
    \"externalId\": \"lead-1042\",
    \"callbackUrl\": \"https://crm.example/signudoc\",
    \"send\": true,
    \"filename\": \"agreement.pdf\",
    \"pdf\": \"$(base64 < agreement.pdf | tr -d '\\n')\",
    \"signers\": [{ \"name\": \"Riley Signer\", \"email\": \"riley@example.com\", \"order\": 1 }],
    \"fields\": [{
      \"type\": \"signature\",
      \"signerIndex\": 0,
      \"page\": 1,
      \"x\": 72,
      \"y\": 640,
      \"width\": 180,
      \"height\": 48,
      \"required\": true
    }]
  }"
```

`201` response:

```json
{
  "id": "…",
  "status": "sent",
  "externalId": "lead-1042",
  "dashboardUrl": "https://sign.example/envelopes/…",
  "signingUrls": [
    {
      "name": "Riley Signer",
      "email": "riley@example.com",
      "order": 1,
      "url": "https://sign.example/sign/…"
    }
  ]
}
```

`url` is `null` for a signer who is not up yet, and for every signer when `send` is false. Signers have 30 days. Reminders are off unless someone turns them on in the app.

## Read an envelope

`GET /api/v1/envelopes/:id`

```bash
curl -sS https://sign.example/api/v1/envelopes/ENVELOPE_ID \
  -H "Authorization: Bearer $SIGNUDOC_API_KEY"
```

`status` is `draft`, `sent`, `completed`, `declined`, `voided`, or `expired`. `expired` is an envelope that is still out for signature and past its deadline. Each signer has `status` (`pending`, `notified`, `signed`, or `declined`) and `notifiedAt`, `viewedAt`, `signedAt`, and `declinedAt`. Times are UTC ISO 8601, or `null`. `externalId` is the value stored at creation, or `null`.

## Download

Both of these stream `application/pdf` and are `404` until `status` is `completed`.

```bash
curl -sS -o signed.pdf \
  https://sign.example/api/v1/envelopes/ENVELOPE_ID/signed-pdf \
  -H "Authorization: Bearer $SIGNUDOC_API_KEY"

curl -sS -o certificate.pdf \
  https://sign.example/api/v1/envelopes/ENVELOPE_ID/certificate \
  -H "Authorization: Bearer $SIGNUDOC_API_KEY"
```

## Void and remind

```bash
curl -sS -X POST https://sign.example/api/v1/envelopes/ENVELOPE_ID/void \
  -H "Authorization: Bearer $SIGNUDOC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Replaced by a new application"}'

curl -sS -X POST https://sign.example/api/v1/envelopes/ENVELOPE_ID/remind \
  -H "Authorization: Bearer $SIGNUDOC_API_KEY"
```

Void works on an envelope that is out for signature. Remind emails the signer whose turn it is. A second reminder for the same signer has to wait a day, and the response then says when it can be sent again. Reminding issues a new signing link; the previous link stops working.

## Webhooks

When an envelope that has a `callbackUrl` changes, SignuDoc `POST`s JSON to that URL:

```json
{
  "event": "signed",
  "envelopeId": "…",
  "externalId": "lead-1042",
  "status": "sent",
  "signer": { "id": "…", "name": "Riley Signer", "email": "riley@example.com" },
  "occurredAt": "2026-11-17T15:04:00.000Z"
}
```

`event` is one of `sent`, `viewed`, `signed`, `completed`, `declined`, `voided`, or `expired`. `signer` is present when the event is about one signer. `status` is the envelope status after the change. `externalId` is `null` when none was stored.

The body is signed with HMAC-SHA256. The header is:

```text
X-SignuDoc-Signature: sha256=<hex digest of the raw body>
```

Compute the HMAC over the raw body with `SIGNUDOC_WEBHOOK_SECRET` and compare it in constant time. An empty or wrong secret means the callback is not sent.

Delivery is tried four times (immediately, then after 1s, 4s, and 16s) on a network error, `408`, `429`, or any `5xx`. Other `4xx` responses are not retried. Each series is stored in `webhook_deliveries`. The signing request does not wait on the callback: a slow or failed webhook cannot stop someone from signing.

Check a delivery in Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function signatureIsValid(rawBody, header, secret) {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const actual = Buffer.from(header ?? "");
  const wanted = Buffer.from(expected);

  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
```
