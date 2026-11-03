export type FormFieldKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'checkbox-group'
  | 'file'
  // Custom widgets (React-Select style comboboxes, etc.) that a plain
  // fill()/selectOption() can't drive reliably. Reported back so the user knows
  // to check them on the real site, never silently guessed at.
  | 'unsupported';

export interface FormFieldOption {
  value: string;
  label: string;
  // Radio / checkbox-group options are separate <input> elements; this is the
  // data-ja-id handle of the one belonging to this option.
  handle?: string;
}

/** One logical question on the form, as extracted from the live page. */
export interface FormField {
  /** Stable handle (data-ja-id) written onto the element in the page. For radio / checkbox groups: the first member's handle. */
  id: string;
  kind: FormFieldKind;
  inputType?: string;
  label: string;
  name?: string;
  placeholder?: string;
  autocomplete?: string;
  required: boolean;
  options?: FormFieldOption[];
  /** True when the site already put a value in (or the user's session did). We never overwrite these. */
  hasValue: boolean;
  note?: string;
}

export type FieldValue = string | boolean | string[];

export type FieldStatus = 'FILLED' | 'PREFILLED' | 'NEEDS_INPUT' | 'UNSUPPORTED';
export type FieldSource = 'profile' | 'document' | 'ai' | 'user' | 'site';

/** A field plus what we did with it - this is what the review UI renders. */
export interface FieldState extends FormField {
  status: FieldStatus;
  source?: FieldSource;
  value?: FieldValue;
  reason?: string;
}
