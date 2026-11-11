/**
 * Single-line input with a floating helper label, used across the predictor
 * form. Unfocused and empty, the label sits where a placeholder normally
 * would; once focused it lifts into a small caption, which is exactly when
 * an empty field can show a real example - so the two never compete for the
 * same spot the way a label-above-a-placeholder-inside layout would.
 */
export default function FloatingField({
  id, label, value, onChange, type = 'text', hint, badge, inputRef, autoFocus, placeholder = ' ',
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
        placeholder={placeholder}
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
