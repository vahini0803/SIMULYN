'use client';

import { BookOpen, GraduationCap, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import { PageTransition } from '@/components/layout/app-shell';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import type { ClassSummary, Paginated, Problem } from '@/lib/types';

/**
 * Admin landing. User management, bulk import and system settings arrive in
 * Phase 6; this reports the counts the API already exposes.
 */
export default function AdminHome() {
  const { user } = useAuth();
  const [counts, setCounts] = useState<{ users?: number; classes?: number; problems?: number }>({});

  useEffect(() => {
    void api
      .get<Paginated<unknown>>('/users?limit=1')
      .then((result) => setCounts((previous) => ({ ...previous, users: result.meta.total })))
      .catch(() => undefined);
    void api
      .get<ClassSummary[]>('/classes')
      .then((result) => setCounts((previous) => ({ ...previous, classes: result.length })))
      .catch(() => undefined);
    void api
      .get<Paginated<Problem>>('/problems?limit=1')
      .then((result) => setCounts((previous) => ({ ...previous, problems: result.meta.total })))
      .catch(() => undefined);
  }, []);

  return (
    <PageTransition>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <header>
          <span className="instrument">System</span>
          <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-[-0.03em] text-white">
            {user?.displayName}
          </h1>
        </header>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {counts.users === undefined ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)
          ) : (
            <>
              <Stat icon={Users} value={counts.users ?? '—'} unit="accounts" />
              <Stat icon={GraduationCap} value={counts.classes ?? '—'} unit="classes" tone="brass" />
              <Stat icon={BookOpen} value={counts.problems ?? '—'} unit="problems" tone="trace" />
            </>
          )}
        </div>
      </div>
    </PageTransition>
  );
}
