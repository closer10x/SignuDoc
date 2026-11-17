/** What the API reports. "expired" is a sent envelope past its deadline. */
export const publicEnvelopeStatuses = [
  "draft",
  "sent",
  "completed",
  "declined",
  "voided",
  "expired",
] as const;

export type PublicEnvelopeStatus = (typeof publicEnvelopeStatuses)[number];

export function publicEnvelopeStatus(
  envelope: { expiresAt?: number | null; status: string },
  nowUnixTimestamp = Math.floor(Date.now() / 1000),
): string {
  if (
    envelope.status === "sent" &&
    typeof envelope.expiresAt === "number" &&
    envelope.expiresAt <= nowUnixTimestamp
  ) {
    return "expired";
  }

  return envelope.status;
}

export function unixToIso(unix: number | null | undefined): string | null {
  return typeof unix === "number" ? new Date(unix * 1000).toISOString() : null;
}
