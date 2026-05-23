/**
 * FormField — server component
 *
 * Composes a `<label>` with a caller-provided input element and renders
 * optional hint and error paragraphs that pair with `aria-describedby`
 * on the input. The DOM order is: label, input (children), hint, error.
 *
 * The CALLER is responsible for wiring `aria-describedby` and
 * `aria-invalid` onto the input itself. This component does not clone or
 * mutate `children`; it just renders the surrounding label + descriptors
 * with predictable element ids so callers can reference them:
 *
 *   - hint paragraph id  = `${id}-hint`   (rendered when `hint` is set)
 *   - error paragraph id = `${id}-error`  (rendered when `error` is set)
 *
 * Example:
 *   <FormField id="email" label="Email" error={errors.email} hint="We never share this.">
 *     <input
 *       id="email"
 *       name="email"
 *       type="email"
 *       aria-describedby={[errors.email ? 'email-error' : null, 'email-hint'].filter(Boolean).join(' ') || undefined}
 *       aria-invalid={errors.email ? true : undefined}
 *     />
 *   </FormField>
 *
 * The error paragraph carries `role="alert"` and `aria-live="polite"` so
 * assistive tech announces validation messages without stealing focus
 * (Req 14.7, 17.2).
 */

import type { ReactNode } from 'react';

export type FormFieldProps = {
  /** id of the input element passed via `children`. Used for the label's `htmlFor` and the hint/error element ids. */
  id: string;
  /** Visible field label. */
  label: string;
  /** Optional helper copy rendered beneath the input. */
  hint?: string;
  /** Optional error message; when set, renders the error paragraph in an alert-live region. */
  error?: string;
  /** The native input/select/textarea element to render between the label and the descriptors. */
  children: ReactNode;
};

export function FormField({ id, label, hint, error, children }: FormFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? (
        <p id={hintId} className="form-field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          className="form-field-error"
          role="alert"
          aria-live="polite"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default FormField;
