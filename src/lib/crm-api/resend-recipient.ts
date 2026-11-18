/** Resend refuses some recipients and the mailer throws a plain Error. That is a bad address, not a server failure. */
export function resendRecipientStatus(error: unknown): { message: string; status: number } | null {
  const message = error instanceof Error ? error.message.trim() : "";
  if (!/invalid [`']to[`'] field/i.test(message)) return null;
  return {
    message: message.slice(0, 240) || "That signer email cannot receive mail.",
    status: 400,
  };
}
