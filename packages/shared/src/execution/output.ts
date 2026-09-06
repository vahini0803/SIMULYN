import { TRACE_MARKER, MAX_TRACE_EVENTS, type TraceEvent } from './trace.types';
import { RESULT_MARKER } from './harness';

/**
 * Splits the driver's return value from whatever the student printed.
 *
 * Without this a stray `print()` inside an otherwise correct solution would
 * land in stdout ahead of the result and fail every case.
 */
/**
 * Pulls trace lines out of stdout, leaving the student's own printing behind.
 *
 * The marker can appear mid-line when their last print had no trailing
 * newline, so each line is split at the marker rather than merely tested with
 * startsWith.
 */
export function extractTraceEvents(raw: string): {
  events: TraceEvent[];
  truncated: boolean;
  remainder: string;
} {
  if (!raw.includes(TRACE_MARKER)) {
    return { events: [], truncated: false, remainder: raw };
  }

  const events: TraceEvent[] = [];
  const kept: string[] = [];

  for (const line of raw.split('\n')) {
    const at = line.indexOf(TRACE_MARKER);
    if (at === -1) {
      kept.push(line);
      continue;
    }

    if (at > 0) kept.push(line.slice(0, at));

    try {
      const event = JSON.parse(line.slice(at + TRACE_MARKER.length)) as TraceEvent;
      if (events.length < MAX_TRACE_EVENTS) events.push(event);
    } catch {
      // A partially flushed line is not worth failing the whole run over.
    }
  }

  return {
    events,
    truncated: events.length >= MAX_TRACE_EVENTS,
    remainder: kept.join('\n'),
  };
}

export function splitDriverOutput(raw: string): { actual: string; studentOutput: string } {
  // lastIndexOf: the driver writes its marker last, so a student echoing the
  // same string earlier cannot hijack the parse.
  const at = raw.lastIndexOf(RESULT_MARKER);
  if (at === -1) return { actual: raw.trim(), studentOutput: '' };

  return {
    actual: raw.slice(at + RESULT_MARKER.length).trim(),
    studentOutput: raw.slice(0, at).trim(),
  };
}
