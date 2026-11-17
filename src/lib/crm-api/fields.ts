import { CrmApiError } from "./errors.ts";

export const AUTO_SIGNATURE_SIZE = { height: 0.07, width: 0.28 };
export const AUTO_DATE_SIZE = { height: 0.045, width: 0.18 };

export type NormalizedRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type PageSize = {
  heightPt: number;
  widthPt: number;
};

/**
 * Values in 0..1 are fractions of the page, from the top left, which is how
 * fields are stored. If any value is greater than 1, all four are points
 * from the top left (y grows downward) and are divided by the page size.
 */
export function normalizeFieldRect(
  rect: NormalizedRect,
  page: PageSize,
): NormalizedRect {
  const points = [rect.x, rect.y, rect.width, rect.height].some(
    (value) => value > 1,
  );

  if (!points) {
    return rect;
  }

  if (page.widthPt <= 0 || page.heightPt <= 0) {
    throw new CrmApiError(
      "This page has no size, so fields cannot be placed.",
      400,
    );
  }

  return {
    height: rect.height / page.heightPt,
    width: rect.width / page.widthPt,
    x: rect.x / page.widthPt,
    y: rect.y / page.heightPt,
  };
}

type AutoSigner = { id: string };

export type AutoField = {
  height: number;
  page: number;
  required: true;
  signerId: string;
  type: "date" | "signature";
  width: number;
  x: number;
  y: number;
};

/**
 * A signature and a date for each signer, stacked upward from the bottom of
 * the last page. The date sits to the right of the signature.
 */
export function autoPlaceSignerFields(
  signers: readonly AutoSigner[],
  pageCount: number,
): AutoField[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new CrmApiError("The document has no pages to sign.", 400);
  }

  const row = 0.09;
  const margin = 0.05;

  if (margin + signers.length * row > 0.98) {
    throw new CrmApiError(
      "This document does not have room for an automatic signature for every signer. Place the fields yourself.",
      400,
    );
  }

  return signers.flatMap((signer, index) => {
    const y = 1 - margin - (signers.length - index) * row;
    const dateY = y + (AUTO_SIGNATURE_SIZE.height - AUTO_DATE_SIZE.height) / 2;

    return [
      {
        height: AUTO_SIGNATURE_SIZE.height,
        page: pageCount,
        required: true as const,
        signerId: signer.id,
        type: "signature" as const,
        width: AUTO_SIGNATURE_SIZE.width,
        x: 0.08,
        y,
      },
      {
        height: AUTO_DATE_SIZE.height,
        page: pageCount,
        required: true as const,
        signerId: signer.id,
        type: "date" as const,
        width: AUTO_DATE_SIZE.width,
        x: 0.08 + AUTO_SIGNATURE_SIZE.width + 0.02,
        y: dateY,
      },
    ];
  });
}
