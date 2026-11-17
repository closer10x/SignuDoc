import { type DbExecutor, queryOne } from "../db/connection.ts";
import { isMissingSchemaError } from "../settings.ts";

/**
 * The optional note stored on an envelope for its signing invitation.
 * A database that has not been migrated yet, or a failed read, yields null
 * so the invitation still goes out exactly as it does without a note.
 */
export async function readEnvelopeNote(
  envelopeId: string,
  database: DbExecutor,
): Promise<string | null> {
  try {
    const row = await queryOne<{ message: string | null }>(
      database,
      `SELECT message FROM envelopes WHERE id = $1`,
      [envelopeId],
    );
    const message = row?.message?.trim();

    return message ? message : null;
  } catch (error) {
    if (!isMissingSchemaError(error)) {
      console.error(
        `[crm-api] Could not read the note for envelope ${envelopeId}:`,
        error,
      );
    }

    return null;
  }
}
