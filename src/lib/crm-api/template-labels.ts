/** Captions printed on the contractor agreement, longest first so a short word does not win. */
export const CONTRACTOR_CAPTIONS = [
  "Business Name / DBA",
  "Termination Notice Days",
  "E&O Minimum $",
  "New Business %",
  "Chargeback Days",
  "Contractor Title",
  "License State",
  "Effective Date",
  "Street Address",
  "Vested Months",
  "Payment Days",
  "Printed Name",
  "Legal Name",
  "License #",
  "Renewal %",
  "Email",
  "Phone",
  "State",
  "City",
  "ZIP",
] as const;

export type LabelField = {
  height: number;
  label?: string;
  page: number;
  type: string;
  width: number;
  x: number;
  y: number;
};

export type PageText = {
  page: number;
  text: string;
  x: number;
  y: number;
};

const FILLABLE = new Set(["text", "number", "date"]);

function canonicalCaption(text: string): string | null {
  const compact = text.replace(/\s+/g, " ").trim();

  if (!compact || compact.length > 48) {
    return null;
  }

  const lower = compact.toLowerCase();

  for (const caption of CONTRACTOR_CAPTIONS) {
    if (lower.includes(caption.toLowerCase())) {
      return caption;
    }
  }

  if (lower === "zip code" || lower === "zipcode") return "ZIP";
  if (lower.includes("e&o") || lower.includes("e & o")) return "E&O Minimum $";
  if (lower.includes("dba") || lower.includes("business name")) return "Business Name / DBA";
  if (lower.includes("license no") || lower.includes("license number")) return "License #";
  if (lower === "title") return "Contractor Title";

  // Exhibit rows and columns are short headings, not sentences.
  if (
    compact.length <= 32 &&
    !/[.!?]$/.test(compact) &&
    compact.split(" ").length <= 5
  ) {
    return compact;
  }

  return null;
}

function overlapsX(field: LabelField, text: PageText): boolean {
  return text.x >= field.x - 0.02 && text.x <= field.x + field.width + 0.02;
}

/**
 * The printed caption for a fill-in box: the nearest short text above it,
 * or on the same line to its left. Boxes that already have a label are left
 * alone. Signature and choice fields are not labeled here.
 */
export function matchFieldLabels(
  fields: readonly LabelField[],
  texts: readonly PageText[],
): { index: number; label: string }[] {
  const used = new Set<string>();
  const matches: { index: number; label: string }[] = [];

  fields.forEach((field, index) => {
    if (!FILLABLE.has(field.type) || field.label?.trim()) {
      return;
    }

    let best: { distance: number; label: string } | null = null;

    for (const text of texts) {
      if (text.page !== field.page) continue;
      const caption = canonicalCaption(text.text);
      if (!caption || used.has(`${field.page}:${caption.toLowerCase()}`)) continue;

      const above =
        overlapsX(field, text) &&
        text.y <= field.y + 0.012 &&
        field.y - text.y <= 0.07;
      const beside =
        text.x < field.x &&
        field.x - text.x <= 0.28 &&
        Math.abs(text.y - field.y) <= 0.02;

      if (!above && !beside) continue;

      const distance = above
        ? field.y - text.y
        : field.x - text.x + 0.02;

      if (!best || distance < best.distance) {
        best = { distance, label: caption };
      }
    }

    if (!best) return;

    used.add(`${field.page}:${best.label.toLowerCase()}`);
    matches.push({ index, label: best.label });
  });

  return matches;
}
