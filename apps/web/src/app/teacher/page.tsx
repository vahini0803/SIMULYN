'use client';

import { Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import { PageTransition } from '@/components/layout/app-shell';
import { Empty } from '@/components/ui/empty';
import { Panel } from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import type { ClassSummary } from '@/lib/types';

/**
 * Teacher landing. The full teaching console — class management, the problem
 * author, exam scheduling and the live proctor grid — is built in Phase 5;
 * this shows the classes that already exist so the area is never empty.
 */
export default function TeacherHome() {
  const { user } = useAuth();
  const [classes, setClasses] = useState<ClassSummary[] | null>(null);

  useEffect(() => {
    void api
      .get<ClassSummary[]>('/classes')
      .then(setClasses)
      .catch(() => setClasses([]));
  }, []);

  return (
    <PageTransition>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <header>
          <span className="instrument">Teaching console</span>
          <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-[-0.03em] text-white">
            {user?.displayName}
          </h1>
        </header>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {!classes ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)
          ) : classes.length === 0 ? (
            <Panel className="sm:col-span-2 lg:col-span-3">
              <Empty
                icon={Users}
                title="No classes yet"
                description="Create a class to enroll students and assign problems."
              />
            </Panel>
          ) : (
            classes.map((cls) => (
              <Panel key={cls.id} hover className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-[15px] font-medium text-paper">{cls.name}</h2>
                  <span className="font-mono text-[11px] text-brass-lit">{cls.code}</span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {[
                    { label: 'students', value: cls._count.enrollments },
                    { label: 'problems', value: cls._count.assignedProblems },
                    { label: 'exams', value: cls._count.exams },
                  ].map((entry) => (
                    <div key={entry.label}>
                      <div className="text-lg font-semibold text-paper tabular">{entry.value}</div>
                      <div className="instrument">{entry.label}</div>
                    </div>
                  ))}
                </div>
              </Panel>
            ))
          )}
        </div>
      </div>
    </PageTransition>
  );
}
