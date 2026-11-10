import {
  forwardRef, useEffect, useImperativeHandle, useRef,
} from 'react';

// Same pattern compose.js and the merge-field audit use server-side - any
// {{token}}, not just the four with an insert button, since templates already
// carry custom ones like {{observation}} that need protecting too.
const TOKEN_PATTERN = /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g;

/**
 * A plain-text field where every `{{merge_field}}` renders as a single,
 * un-editable chip rather than literal characters.
 *
 * The problem this replaces: a merge field was just text in a normal input,
 * so one stray backspace could turn `{{first_name}}` into `{{first_nam}}` -
 * silently, since nothing short of re-reading the whole subject line catches
 * it. A contenteditable=false span is atomic to the browser's own caret and
 * backspace handling - landing the cursor inside one isn't possible, and
 * deleting one next to it removes the whole token in one step. No library;
 * this is the standard technique editors use for mention/tag chips.
 *
 * Controlled, but only resyncs its DOM from `value` when that value didn't
 * just come from this component's own `onChange` - otherwise every keystroke
 * would rebuild the contenteditable and throw the caret back to the start.
 */
const MergeFieldInput = forwardRef(function MergeFieldInput({
  id, value, onChange, onBlur, multiline = false, placeholder,
}, ref) {
  const divRef = useRef(null);
  // Sentinel so the first render always builds, including an empty string.
  const lastEmitted = useRef(Symbol('unset'));

  useEffect(() => {
    const el = divRef.current;
    if (!el || value === lastEmitted.current) return;
    el.innerHTML = '';
    el.appendChild(buildNodes(value));
    lastEmitted.current = value;
  }, [value]);

  function emit() {
    const text = serialize(divRef.current);
    lastEmitted.current = text;
    onChange?.(text);
    return text;
  }

  function handleInput() {
    emit();
  }

  function handleBlur() {
    onBlur?.(serialize(divRef.current));
  }

  function handleKeyDown(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!multiline) return;
    // A single trailing <br> with nothing after it is ambiguous to Blink's
    // own caret handling - typing right after one lands *before* it instead
    // (confirmed empirically; neither an explicit Range nor forcing
    // execCommand('defaultParagraphSeparator', 'br') changed that). A second,
    // sacrificial <br> fixes it: Blink only absorbs the one actually at the
    // end, so typing between the two lands after the first - the standard
    // workaround for this specific Blink behaviour.
    const first = document.createElement('br');
    const second = document.createElement('br');
    insertAtCursor(divRef.current, first);
    first.after(second);
    const range = document.createRange();
    range.setStartAfter(first);
    range.setEndAfter(first);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    emit();
  }

  // Force plain text on paste - formatted HTML from Word/Gmail has no place
  // here, and this also re-scans the result so a pasted {{token}} becomes a
  // real chip immediately rather than sitting there as breakable text.
  function handlePaste(e) {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    insertAtCursor(divRef.current, document.createTextNode(text));
    const resynced = serialize(divRef.current);
    divRef.current.innerHTML = '';
    divRef.current.appendChild(buildNodes(resynced));
    placeCursorAtEnd(divRef.current);
    lastEmitted.current = resynced;
    onChange?.(resynced);
  }

  useImperativeHandle(ref, () => ({
    insertToken(token) {
      const el = divRef.current;
      el.focus();
      const chip = document.createElement('span');
      chip.contentEditable = 'false';
      chip.className = 'merge-chip';
      chip.dataset.token = token;
      chip.textContent = token;
      insertAtCursor(el, chip);
      emit();
    },
  }));

  return (
    <div
      ref={divRef}
      id={id}
      className={`merge-field-input ${multiline ? 'multiline' : ''}`}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline={multiline}
      data-placeholder={placeholder}
      onInput={handleInput}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
    />
  );
});

export default MergeFieldInput;

function buildNodes(value) {
  const frag = document.createDocumentFragment();
  const parts = String(value ?? '').split('\n');
  parts.forEach((line, lineIndex) => {
    if (lineIndex > 0) frag.appendChild(document.createElement('br'));
    let lastIndex = 0;
    let match;
    TOKEN_PATTERN.lastIndex = 0;
    while ((match = TOKEN_PATTERN.exec(line))) {
      if (match.index > lastIndex) {
        frag.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
      }
      const chip = document.createElement('span');
      chip.contentEditable = 'false';
      chip.className = 'merge-chip';
      chip.dataset.token = match[0];
      chip.textContent = match[0];
      frag.appendChild(chip);
      lastIndex = TOKEN_PATTERN.lastIndex;
    }
    if (lastIndex < line.length) frag.appendChild(document.createTextNode(line.slice(lastIndex)));
  });
  return frag;
}

function serialize(container) {
  let out = '';
  for (const node of container.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent;
    } else if (node.tagName === 'BR') {
      out += '\n';
    } else if (node.dataset?.token) {
      out += node.dataset.token;
    } else {
      out += node.textContent;
    }
  }
  return out;
}

/** Inserts a node at the current selection, or at the end if focus was lost. */
function insertAtCursor(container, node) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !container.contains(sel.anchorNode)) {
    placeCursorAtEnd(container);
  }
  const range = window.getSelection().getRangeAt(0);
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  const sel2 = window.getSelection();
  sel2.removeAllRanges();
  sel2.addRange(range);
}

function placeCursorAtEnd(container) {
  const range = document.createRange();
  range.selectNodeContents(container);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
