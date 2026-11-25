import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { NdjsonParser } from '../src/ndjson-parser.ts';
import { fixturePath } from './support/fixtures.ts';

function parseAll(parser: NdjsonParser, chunks: readonly Uint8Array[]): unknown[] {
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.end()];
}

describe('NdjsonParser', () => {
  it('yields the same events when a real stream arrives one byte at a time', () => {
    // #given the raw stdout of a real kane-cli run, including multi-byte UTF-8 such as "Café Núñez"
    const raw = readFileSync(fixturePath('pf02-1-pass', 'ndjson'));
    const whole = parseAll(new NdjsonParser(), [raw]);
    const bytewise = new NdjsonParser();

    // #when it is fed in single-byte chunks
    const events = parseAll(
      bytewise,
      [...raw].map((byte) => Uint8Array.of(byte)),
    );

    // #then every event decodes identically and nothing is dropped
    expect(events).toEqual(whole);
    expect(events).toHaveLength(11);
    expect(bytewise.warnings).toEqual([]);
  });

  it('strips CR from CRLF-terminated lines', () => {
    // #given two events separated by CRLF
    const parser = new NdjsonParser();

    // #when the stream is parsed
    const events = parseAll(parser, [Buffer.from('{"step":1,"status":"done"}\r\n{"type":"run_end"}\r\n')]);

    // #then both events parse without warnings
    expect(events).toEqual([{ step: 1, status: 'done' }, { type: 'run_end' }]);
    expect(parser.warnings).toEqual([]);
  });

  it('handles a CRLF terminator split across chunks', () => {
    // #given a line whose CR and LF arrive in separate chunks
    const parser = new NdjsonParser();

    // #when both chunks are pushed
    const events = parseAll(parser, [Buffer.from('{"a":1}\r'), Buffer.from('\n')]);

    // #then the event is parsed once
    expect(events).toEqual([{ a: 1 }]);
  });

  it('flushes a final line that has no newline on end()', () => {
    // #given a stream that stops without a trailing newline
    const parser = new NdjsonParser();
    const pushed = parser.push(Buffer.from('{"type":"run_end"}'));

    // #when the stream ends
    const flushed = parser.end();

    // #then the last line is only produced by end()
    expect(pushed).toEqual([]);
    expect(flushed).toEqual([{ type: 'run_end' }]);
  });

  it('drops a malformed JSON line with a warning and keeps parsing', () => {
    // #given a non-JSON line between two good events
    const parser = new NdjsonParser();

    // #when the stream is parsed
    const events = parseAll(parser, [Buffer.from('{"a":1}\nnot json at all\n{"b":2}\n')]);

    // #then the bad line is reported by number and the good lines survive
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parser.warnings).toEqual(['line 2: not valid JSON, dropped']);
  });

  it('drops JSON values that are not objects', () => {
    // #given an array and a number on their own lines
    const parser = new NdjsonParser();

    // #when the stream is parsed
    const events = parseAll(parser, [Buffer.from('[1,2]\n42\n')]);

    // #then neither is treated as an event
    expect(events).toEqual([]);
    expect(parser.warnings).toHaveLength(2);
  });

  it('drops an oversized line, even across chunks, and recovers on the next line', () => {
    // #given a 1 KiB limit and a 3 KiB line delivered in 1 KiB chunks
    const parser = new NdjsonParser({ maxLineBytes: 1024 });
    const oversized = Buffer.from(`{"pad":"${'x'.repeat(3 * 1024)}"}\n`);
    const chunks = [0, 1024, 2048, 3072].map((start) => oversized.subarray(start, start + 1024));

    // #when the oversized line is followed by a normal one
    const events = parseAll(parser, [...chunks, Buffer.from('{"ok":true}\n')]);

    // #then only the normal line survives and the drop is reported
    expect(events).toEqual([{ ok: true }]);
    expect(parser.warnings).toEqual(['line 1: exceeds 1024 bytes, dropped']);
  });

  it('accepts a line of exactly the byte limit', () => {
    // #given a line exactly 16 bytes long followed by CRLF
    const line = '{"k":"12345678"}';
    const parser = new NdjsonParser({ maxLineBytes: Buffer.byteLength(line) });

    // #when it is parsed
    const events = parseAll(parser, [Buffer.from(`${line}\r\n`)]);

    // #then the terminator does not count against the limit
    expect(events).toEqual([{ k: '12345678' }]);
  });

  it('rejects invalid UTF-8 instead of substituting replacement characters', () => {
    // #given a line holding a lone continuation byte inside a string
    const parser = new NdjsonParser();
    const bad = Buffer.concat([Buffer.from('{"a":"'), Buffer.of(0x80), Buffer.from('"}\n')]);

    // #when it is parsed
    const events = parseAll(parser, [bad]);

    // #then the line is dropped with a warning
    expect(events).toEqual([]);
    expect(parser.warnings).toEqual(['line 1: invalid UTF-8, dropped']);
  });

  it('keeps unknown event types untouched', () => {
    // #given an event type this adapter has never seen
    const parser = new NdjsonParser();

    // #when it is parsed
    const events = parseAll(parser, [Buffer.from('{"type":"future_event","x":[1]}\n')]);

    // #then it is passed through as-is
    expect(events).toEqual([{ type: 'future_event', x: [1] }]);
  });

  it('ignores blank lines silently', () => {
    // #given blank and whitespace-only lines
    const parser = new NdjsonParser();

    // #when they are parsed
    const events = parseAll(parser, [Buffer.from('\n  \r\n{"a":1}\n\n')]);

    // #then they produce neither events nor warnings
    expect(events).toEqual([{ a: 1 }]);
    expect(parser.warnings).toEqual([]);
  });

  it('refuses a non-positive line limit', () => {
    // #given an invalid limit
    const create = (): NdjsonParser => new NdjsonParser({ maxLineBytes: 0 });

    // #when the parser is constructed
    // #then construction fails
    expect(create).toThrow(RangeError);
  });
});
