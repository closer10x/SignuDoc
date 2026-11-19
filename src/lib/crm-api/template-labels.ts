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

const EXHIBIT_CAPTIONS = [
  "Line of business / product",
  "Carrier or market (optional)",
  "Notes",
];

function canonicalCaption(text: string): string | null {
  const compact = text.replace(/\s+/g, " ").trim();

  if (!compact || compact.length > 60) {
    return null;
  }

  const lower = compact.toLowerCase();

  for (const caption of [...CONTRACTOR_CAPTIONS, ...EXHIBIT_CAPTIONS]) {
    if (lower === caption.toLowerCase() || lower.includes(caption.toLowerCase())) {
      return caption;
    }
  }

  if (lower.includes("e&o") || lower.includes("e & o") || lower.includes("errors and omissions")) return "E&O Minimum $";
  if (lower.includes("termination")) return "Termination Notice Days";
  if (lower.includes("chargeback")) return "Chargeback Days";
  if (lower.includes("payment day") || lower === "payment timing") return "Payment Days";
  if (lower.includes("vested month") || lower === "vested for") return "Vested Months";
  if (lower.includes("license state")) return "License State";
  if (lower.includes("license #") || lower.includes("license no") || lower.includes("license number")) return "License #";
  if (lower.includes("printed name")) return "Printed Name";
  if (lower === "contractor title" || lower === "title") return "Contractor Title";
  if (lower.includes("new business")) return "New Business %";
  if (lower.includes("renewal")) return "Renewal %";

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
  const usedText = new Set<string>();
  const matches: { index: number; label: string }[] = [];

  fields.forEach((field, index) => {
    if (!FILLABLE.has(field.type) || field.label?.trim()) {
      return;
    }

    let best: { distance: number; label: string; textKey: string } | null = null;

    for (const text of texts) {
      if (text.page !== field.page) continue;
      const caption = canonicalCaption(text.text);
      const textKey = `${text.page}:${text.x.toFixed(3)}:${text.y.toFixed(3)}:${text.text}`;
      if (!caption || usedText.has(textKey)) continue;

      const above =
        overlapsX(field, text) &&
        text.y <= field.y + 0.012 &&
        field.y - text.y <= 0.11;
      const beside =
        text.x < field.x &&
        field.x - text.x <= 0.28 &&
        Math.abs(text.y - field.y) <= 0.02;

      if (!above && !beside) continue;

      const distance = above
        ? field.y - text.y
        : field.x - text.x + 0.02;

      if (!best || distance < best.distance) {
        best = { distance, label: caption, textKey };
      }
    }

    if (!best) return;

    usedText.add(best.textKey);
    matches.push({ index, label: best.label });
  });

  return matches;
}
