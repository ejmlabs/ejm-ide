/// <reference path="./sdk.d.ts" />
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './panel.css';

const api = window.workbench;

function Notebook() {
  const [references, setReferences] = useState(api.getContext());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    setReferences(api.getContext());
    return api.onContextChange(setReferences);
  }, []);
  useEffect(
    () =>
      api.onCommand((command) => {
        if (command === 'clear') {
          setChecked(new Set());
          setNote('');
          setStatus('Notebook cleared.');
        }
      }),
    [],
  );

  function sendNote() {
    const completed = references.filter((reference) => checked.has(reference.id));
    const summary = completed.map((reference) => `- [x] ${reference.label}`).join('\n');
    api.addToChat({
      label: 'Selection notebook',
      content: [summary, note.trim()].filter(Boolean).join('\n\n'),
    });
    setStatus('Added to the chat composer.');
  }

  return (
    <main>
      <h1>Selection notebook</h1>
      <p>
        References attached to chat appear here. Mark what you have reviewed, then send your note.
      </p>
      {!references.length && <p>Add a source selection, caller, or diagnostic to chat to begin.</p>}
      <ul>
        {references.map((reference) => (
          <li key={reference.id}>
            <label>
              <input
                type="checkbox"
                checked={checked.has(reference.id)}
                onChange={(event) => {
                  setChecked((previous) => {
                    const next = new Set(previous);
                    event.target.checked ? next.add(reference.id) : next.delete(reference.id);
                    return next;
                  });
                }}
              />
              <span title={reference.label}>{reference.label}</span>
            </label>
            {reference.uri && (
              <button
                type="button"
                onClick={() => api.openSource(reference.id)}
                title="Open source"
              >
                Open
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                api.addToChat({ referenceId: reference.id });
                setStatus('Reference added to chat.');
              }}
              title="Add reference to chat"
            >
              +
            </button>
          </li>
        ))}
      </ul>
      <textarea
        aria-label="Notebook note"
        placeholder="What should the agent know about these references?"
        value={note}
        maxLength={12000}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!note.trim() && !checked.size}
          onClick={sendNote}
        >
          Add note to chat
        </button>
        <button
          type="button"
          onClick={() => {
            setChecked(new Set());
            setNote('');
          }}
        >
          Clear
        </button>
      </div>
      <p className="status" aria-live="polite">
        {status}
      </p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('The notebook root element is missing.');
createRoot(root).render(<Notebook />);
