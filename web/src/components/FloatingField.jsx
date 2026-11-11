/**
 * Single-line input with a floating helper label, used across the predictor
 * form. The label starts as placeholder text and lifts into a small caption
 * once the field is focused or has a value, so the field never needs both a
 * label above it and a placeholder inside it saying almost the same thing.
 */
export default function FloatingField({
  id, label, value, onChange, type = 'text', hint, badge, inputRef, autoFocus,
}) {
  const filled = Boolean(value);

  return (
    <div className={`floating-field ${filled ? 'filled' : ''}`}>
      <input
        id={id}
        ref={inputRef}
        className="floating-input"
        type={type}
        value={value}
        placeholder=" "
        autoFocus={autoFocus}
        onChange={onChange}
      />
      <label htmlFor={id} className="floating-label">
        {label}
        {badge !== undefined && <span className="counter-badge">{badge}</span>}
      </label>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}
