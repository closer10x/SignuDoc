import assert from "node:assert/strict";
import { test } from "node:test";

import { type Branding } from "../branding.ts";
import { buildSigningInvitationEmail } from "./signing-invitation-email.ts";

const branding: Branding = {
  brandColor: null,
  contactUrl: null,
  hosted: false,
  logoUrl: null,
  organizationName: null,
  privacyUrl: null,
  productName: "Northwind",
  signupAvailable: false,
  supportAddress: null,
  termsUrl: null,
};

function invitation(note?: string) {
  return buildSigningInvitationEmail({
    branding,
    envelopeTitle: "Lease",
    note,
    senderName: "Ada Admin",
    signerEmail: "riley@example.com",
    signerName: "Riley Signer",
    signingUrl: "https://sign.example/sign/token",
  });
}

test("a signing invitation without a note is unchanged apart from that note", () => {
  const message = invitation();
  const intro = 'Ada Admin sent you "Lease" through Northwind.';

  assert.equal(
    message.textBody.slice(
      message.textBody.indexOf(intro) + intro.length,
      message.textBody.indexOf("Review and sign the document here:"),
    ),
    "\n\n",
  );
  assert.equal(message.textBody.includes("Please sign today"), false);
});

test("a note is added to the invitation and escaped in HTML", () => {
  const message = invitation("Please sign today <thanks>");

  assert.match(
    message.textBody,
    /through Northwind\.\n\nPlease sign today <thanks>\n\nReview and sign/,
  );
  assert.match(message.htmlBody ?? "", /Please sign today &lt;thanks&gt;/);
  assert.equal(message.to, "riley@example.com");
});
