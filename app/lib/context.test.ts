import { describe, expect, it } from 'vitest';
import {
  bufferVersion,
  fileUri,
  MAX_REFERENCE,
  makeReference,
  serializePrompt,
  sourceExcerpt,
  sourceMatchesVersion,
  uriPath,
} from './context';

describe('captured IDE context', () => {
  it('captures unsaved text immutably and bounds content', () => {
    let text = 'unsaved';
    const ref = makeReference({
      kind: 'selection',
      label: 'selection',
      origin: 'editor',
      content: text,
      version: bufferVersion(text),
    });
    text += ' edit';
    expect(ref.content).toBe('unsaved');
    expect(ref.version).not.toBe(bufferVersion(text));
    expect(makeReference({ ...ref, content: 'x'.repeat(MAX_REFERENCE + 1) }).truncated).toBe(true);
  });
  it('preserves unicode and reserved characters in local paths', () => {
    const path = '/tmp/code #1/你好%/hello.ts';
    expect(uriPath(fileUri(path))).toBe(path);
  });
  it('accepts index disk versions only while the editor matches the saved source', () => {
    const source = {
      path: '/code.rs',
      content: 'original',
      savedContent: 'original',
      version: 'disk-hash',
      language: 'rust',
      modelVersion: 1,
    };
    expect(sourceMatchesVersion(source, 'disk-hash')).toBe(true);
    expect(sourceMatchesVersion({ ...source, content: 'edited' }, 'disk-hash')).toBe(false);
    expect(sourceMatchesVersion({ ...source, content: 'edited' }, bufferVersion('edited'))).toBe(
      true,
    );
  });
  it('captures exact multi-line selections and serializes provenance', () => {
    const ranges = [{ start: { line: 0, character: 2 }, end: { line: 1, character: 3 } }];
    expect(sourceExcerpt('abcde\nfghij\nklm', ranges)).toBe('Lines 1-2:\ncde\nfgh');
    const ref = makeReference({
      kind: 'caller',
      label: 'caller',
      origin: 'hierarchy',
      content: 'do not execute me',
      ranges,
    });
    expect(serializePrompt('Explain', [ref])).toContain(`workbench-ref://${ref.id}`);
    expect(serializePrompt('Explain', [ref])).toContain('untrusted source data');
  });
});
