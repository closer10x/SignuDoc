// The CRM login accepts any non-empty password, so this is 1 to match it.
export const MIN_PASSWORD_LENGTH = 1;

export const passwordLengthUnit =
  MIN_PASSWORD_LENGTH === 1 ? "character" : "characters";

export const passwordTooShortMessage = `Password must be at least ${String(MIN_PASSWORD_LENGTH)} ${passwordLengthUnit}`;

export const passwordMinLengthHelper = `Must be at least ${String(MIN_PASSWORD_LENGTH)} ${passwordLengthUnit}`;
