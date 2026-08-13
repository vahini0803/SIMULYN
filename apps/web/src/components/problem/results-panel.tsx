'use client';

import { AlertTriangle, CheckCircle2, Clock, Terminal, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Empty } from '@/components/ui/empty';
import type { EvaluationResult, RunResult, TestOutcome } from '@/lib/types';
import { cn, formatDuration } from '@/lib/utils';

function Row({ label, value, tone }: { label: string; value: string; tone?: 'pass' | 'fail' }) {
  return (
    <div className="grid grid-cols-[76px_1fr] gap-3 py-1">
      <span className="instrument pt-0.5">{label}</span>
      <pre
        className={cn(
          'overflow-x-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap',
          tone === 'pass' && 'text-trace',
          tone === 'fail' && 'text-fault',
          !tone && 'text-paper',
        )}
      >
        {value}
      </pre>
    </div>
  );
}

function TestCase({ outcome, index }: { outcome: TestOutcome; index: number }) {
  return (
    <details
      className={cn(
        'group rounded-lg border transition-colors',
        outcome.passed ? 'border-trace/25 bg-trace/[0.04]' : 'border-fault/30 bg-fault/[0.05]',
      )}
      open={!outcome.passed}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5">
        {outcome.passed ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-trace" strokeWidth={1.8} />
        ) : (
          <XCircle className="h-4 w-4 shrink-0 text-fault" strokeWidth={1.8} />
        )}
        <span className="text-[13px] text-paper">Case {index + 1}</span>
        {outcome.isHidden ? <Badge>hidden</Badge> : null}
        {outcome.timedOut ? <Badge tone="warn">timed out</Badge> : null}
        <span className="ml-auto font-mono text-[10px] text-faint tabular">
          {formatDuration(outcome.executionMs)}
        </span>
      </summary>

      <div className="border-t border-line px-3 py-2">
        {outcome.isHidden && outcome.input === 'hidden' ? (
          <p className="py-1 text-[12px] text-muted">
            This case is hidden. You can see whether it passed, but not its input.
          </p>
        ) : (
          <>
            <Row label="Input" value={outcome.input} />
            <Row label="Expected" value={outcome.expected} tone="pass" />
            <Row
              label="Your output"
              value={outcome.actual ?? '(no output)'}
              tone={outcome.passed ? 'pass' : 'fail'}
            />
          </>
        )}
        {outcome.stderr ? <Row label="stderr" value={outcome.stderr} tone="fail" /> : null}
      </div>
    </details>
  );
}

export function TestResults({
  evaluation,
  running,
}: {
  evaluation: EvaluationResult | null;
  running: boolean;
}) {
  if (running) {
    return (
      <div className="flex items-center gap-2.5 px-4 py-8 text-sm text-muted">
        <span className="h-2 w-2 animate-pulse rounded-full bg-violet-lit" />
        Running your code against the test cases…
      </div>
    );
  }

  if (!evaluation) {
    return (
      <Empty
        icon={CheckCircle2}
        title="No results yet"
        description="Submit your solution to run it against every test case, hidden ones included."
      />
    );
  }

  if (evaluation.compileError) {
    return (
      <div className="p-4">
        <div className="flex items-center gap-2 text-[13px] text-fault">
          <AlertTriangle className="h-4 w-4" strokeWidth={1.8} />
          Compilation failed
        </div>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-fault/30 bg-fault/[0.06] p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fault">
          {evaluation.compileError}
        </pre>
      </div>
    );
  }

  return (
    <div className="p-3">
      <div className="mb-3 flex items-center gap-3 px-1">
        <span
          className={cn(
            'text-[13px] font-medium',
            evaluation.allPassed ? 'text-trace' : 'text-fault',
          )}
        >
          {evaluation.passedCount} of {evaluation.totalCount} cases passed
        </span>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/5">
          <div
            className={cn('h-full rounded-full', evaluation.allPassed ? 'bg-trace' : 'bg-fault')}
            style={{ width: `${(evaluation.passedCount / evaluation.totalCount) * 100}%` }}
          />
        </div>
        <span className="flex items-center gap-1 font-mono text-[10px] text-faint">
          <Clock className="h-3 w-3" />
          {formatDuration(evaluation.totalMs)}
        </span>
      </div>

      <div className="space-y-1.5">
        {evaluation.results.map((outcome, index) => (
          <TestCase key={index} outcome={outcome} index={index} />
        ))}
      </div>
    </div>
  );
}

export function ConsoleOutput({ result, running }: { result: RunResult | null; running: boolean }) {
  if (running) {
    return (
      <div className="flex items-center gap-2.5 px-4 py-8 text-sm text-muted">
        <span className="h-2 w-2 animate-pulse rounded-full bg-violet-lit" />
        Executing…
      </div>
    );
  }

  if (!result) {
    return (
      <Empty
        icon={Terminal}
        title="Console is empty"
        description="Press Run to execute your code and see stdout and stderr here."
      />
    );
  }

  return (
    <div className="p-4 font-mono text-[12px] leading-relaxed">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {result.timedOut ? (
          <Badge tone="warn">timed out</Badge>
        ) : result.compileError ? (
          <Badge tone="fail">compile error</Badge>
        ) : (
          <Badge tone={result.exitCode === 0 ? 'pass' : 'fail'}>exit {result.exitCode ?? '—'}</Badge>
        )}
        <span className="text-[10px] text-faint">{formatDuration(result.executionMs)}</span>
      </div>

      {result.compileError ? (
        <pre className="whitespace-pre-wrap text-fault">{result.compileError}</pre>
      ) : null}
      {result.stdout ? <pre className="whitespace-pre-wrap text-paper">{result.stdout}</pre> : null}
      {result.stderr ? (
        <pre className="mt-2 whitespace-pre-wrap text-fault">{result.stderr}</pre>
      ) : null}
      {!result.stdout && !result.stderr && !result.compileError ? (
        <span className="text-faint">(no output)</span>
      ) : null}
    </div>
  );
}
