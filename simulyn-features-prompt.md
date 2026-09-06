# Task: Add research-study module + theme customizer to Simulyn

Implement two features in this repo (a Turborepo monorepo: NestJS API in
`apps/api`, Next.js 15 app in `apps/web`, Prisma schema in
`packages/shared`). Create every file below exactly as given, then wire up
the listed one-line edits to existing files, then run the setup commands.

---

## Feature 1 — Research study module (consent + SUS survey + data export)

### 1a. Prisma schema — `packages/shared/prisma/schema.prisma`

Add a relation on the `User` model (near its other relation fields):

```prisma
  studyConsent    StudyConsent?
  surveyResponse  SurveyResponse?
```

Add these two new models at the end of the file:

```prisma
// ── RESEARCH STUDY (evaluation data for the paper) ──

model StudyConsent {
  id          String   @id @default(cuid())
  userId      String   @unique
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  consented   Boolean  @default(true)
  ageConfirm  Boolean  @default(true)
  createdAt   DateTime @default(now())
}

// A short System Usability Scale (10 items, 1-5 Likert) plus free text,
// taken once per participant near the end of the study window.
model SurveyResponse {
  id          String   @id @default(cuid())
  userId      String   @unique
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  susAnswers  String   // JSON array of 10 ints, 1-5
  susScore    Float    // computed 0-100 SUS score
  freeText    String?
  createdAt   DateTime @default(now())
}
```

### 1b. `packages/shared/src/types/index.ts`

Add `StudyConsent` and `SurveyResponse` to the existing `export type { ... } from '@prisma/client'` block.

### 1c. New file — `apps/api/src/modules/research/research.module.ts`

```ts
import { Module } from '@nestjs/common';

import { ResearchController } from './research.controller';
import { ResearchService } from './research.service';

@Module({
  controllers: [ResearchController],
  providers: [ResearchService],
})
export class ResearchModule {}
```

### 1d. New file — `apps/api/src/modules/research/research.controller.ts`

```ts
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@simulyn/shared';
import archiver from 'archiver';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { Response } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { ResearchService } from './research.service';

export class ConsentDto {
  // Body is intentionally minimal: presence of a POST from an authenticated
  // user is the consent action itself; no extra fields required.
}

export class SurveyDto {
  @IsArray()
  @ArrayMinSize(10)
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(5, { each: true })
  susAnswers!: number[];

  @IsOptional()
  @IsString()
  freeText?: string;
}

@ApiTags('research')
@ApiBearerAuth()
@Controller('research')
export class ResearchController {
  constructor(private readonly research: ResearchService) {}

  @Get('status')
  @ApiOperation({ summary: 'Whether the current user has given consent / taken the survey' })
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.research.status(user.id);
  }

  @Post('consent')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Record study consent for the current user' })
  consent(@CurrentUser() user: AuthenticatedUser) {
    return this.research.recordConsent(user.id);
  }

  @Post('survey')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Submit the exit System Usability Scale survey' })
  survey(@Body() dto: SurveyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.research.recordSurvey(user.id, dto.susAnswers, dto.freeText);
  }

  @Post('export')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.TEACHER, Role.ADMIN)
  @ApiOperation({ summary: 'Download a pseudonymized zip of all study data as CSVs' })
  async export(@CurrentUser() user: AuthenticatedUser, @Res() res: Response) {
    const files = await this.research.exportStudyData(user);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="simulyn-study-export.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    for (const [name, csv] of Object.entries(files)) {
      archive.append(csv, { name: `${name}.csv` });
    }
    await archive.finalize();
  }
}
```

### 1e. New file — `apps/api/src/modules/research/research.service.ts`

```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { Role } from '@simulyn/shared';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(','));
  return lines.join('\n');
}

function assertResearcher(user: AuthenticatedUser) {
  if (user.role !== Role.TEACHER && user.role !== Role.ADMIN) {
    throw new BadRequestException('Only teachers/admins can export study data');
  }
}

@Injectable()
export class ResearchService {
  constructor(private readonly prisma: PrismaService) {}

  // ── participant-facing: consent + exit survey ──────────────────────

  async recordConsent(userId: string) {
    return this.prisma.studyConsent.upsert({
      where: { userId },
      create: { userId, consented: true, ageConfirm: true },
      update: { consented: true },
    });
  }

  async status(userId: string) {
    const [consent, survey] = await Promise.all([
      this.prisma.studyConsent.findUnique({ where: { userId }, select: { userId: true } }),
      this.prisma.surveyResponse.findUnique({ where: { userId }, select: { userId: true } }),
    ]);
    return { consented: !!consent, surveyed: !!survey };
  }

  async recordSurvey(userId: string, susAnswers: number[], freeText?: string) {
    if (susAnswers.length !== 10 || susAnswers.some((a) => a < 1 || a > 5)) {
      throw new BadRequestException('susAnswers must be 10 integers between 1 and 5');
    }
    // Standard SUS scoring: odd items (1-indexed) contribute (score-1),
    // even items contribute (5-score); sum * 2.5 -> 0-100.
    let total = 0;
    susAnswers.forEach((score, i) => {
      total += i % 2 === 0 ? score - 1 : 5 - score;
    });
    const susScore = total * 2.5;

    return this.prisma.surveyResponse.upsert({
      where: { userId },
      create: { userId, susAnswers: JSON.stringify(susAnswers), susScore, freeText },
      update: { susAnswers: JSON.stringify(susAnswers), susScore, freeText },
    });
  }

  // ── researcher-facing: pseudonymized export ─────────────────────────
  // Every table is keyed by userId only (no email/name), and a stable
  // per-export pseudonym map is generated so the CSVs can be joined
  // without re-identifying anyone from the export itself.

  async exportStudyData(requester: AuthenticatedUser) {
    assertResearcher(requester);

    const [users, submissions, testResults, violations, examAttempts, consents, surveys] =
      await Promise.all([
        this.prisma.user.findMany({ select: { id: true, role: true, createdAt: true } }),
        this.prisma.submission.findMany({
          select: {
            id: true,
            userId: true,
            problemId: true,
            language: true,
            passed: true,
            score: true,
            createdAt: true,
          },
        }),
        this.prisma.testResult.findMany({
          select: { id: true, submissionId: true, passed: true, timedOut: true },
        }),
        this.prisma.violation.findMany({
          select: {
            id: true,
            examAttemptId: true,
            userId: true,
            typeKey: true,
            weight: true,
            timeRemaining: true,
            createdAt: true,
          },
        }),
        this.prisma.examAttempt.findMany({
          select: {
            id: true,
            examId: true,
            userId: true,
            startedAt: true,
            submittedAt: true,
            autoSubmitted: true,
            totalScore: true,
            integrityScore: true,
            flagged: true,
            terminated: true,
            violationBaseline: true,
          },
        }),
        this.prisma.studyConsent.findMany({ select: { userId: true, createdAt: true } }),
        this.prisma.surveyResponse.findMany({
          select: { userId: true, susAnswers: true, susScore: true, freeText: true },
        }),
      ]);

    // Pseudonym map: pXXX in a stable but arbitrary order per export.
    const idMap = new Map<string, string>();
    users.forEach((u, i) => idMap.set(u.id, `p${String(i + 1).padStart(3, '0')}`));
    const pseudo = (id: string) => idMap.get(id) ?? id;

    const files: Record<string, string> = {
      participants: toCsv(
        users.map((u) => ({ participantId: pseudo(u.id), role: u.role, createdAt: u.createdAt })),
      ),
      submissions: toCsv(
        submissions.map((s) => ({
          submissionId: s.id,
          participantId: pseudo(s.userId),
          problemId: s.problemId,
          language: s.language,
          passed: s.passed,
          score: s.score,
          createdAt: s.createdAt,
        })),
      ),
      test_results: toCsv(testResults),
      violations: toCsv(
        violations.map((v) => ({
          violationId: v.id,
          examAttemptId: v.examAttemptId,
          participantId: pseudo(v.userId),
          type: v.typeKey,
          weight: v.weight,
          timeRemainingSec: v.timeRemaining,
          createdAt: v.createdAt,
        })),
      ),
      exam_attempts: toCsv(
        examAttempts.map((a) => ({
          attemptId: a.id,
          examId: a.examId,
          participantId: pseudo(a.userId),
          startedAt: a.startedAt,
          submittedAt: a.submittedAt,
          autoSubmitted: a.autoSubmitted,
          totalScore: a.totalScore,
          integrityScore: a.integrityScore,
          flagged: a.flagged,
          terminated: a.terminated,
          violationBaseline: a.violationBaseline,
        })),
      ),
      consent: toCsv(
        consents.map((c) => ({ participantId: pseudo(c.userId), consentedAt: c.createdAt })),
      ),
      survey_sus: toCsv(
        surveys.map((s) => ({
          participantId: pseudo(s.userId),
          susScore: s.susScore,
          susAnswers: s.susAnswers,
          freeText: s.freeText ?? '',
        })),
      ),
    };

    return files;
  }
}
```

### 1f. Register the module — `apps/api/src/app.module.ts`

Add the import:
```ts
import { ResearchModule } from './modules/research/research.module';
```
Add `ResearchModule` to the `imports: [...]` array alongside the other feature modules.

### 1g. New file — `apps/web/src/components/research/consent-gate.tsx`

```tsx
'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';

const STORAGE_KEY = 'simulyn.study-consent-seen';

/**
 * Blocking overlay shown once per participant before they can use the app,
 * for the classroom evaluation study. Skips silently if the study endpoints
 * are unreachable so it never locks anyone out of the real product.
 */
export function ConsentGate() {
  const { user } = useAuth();
  const [needsConsent, setNeedsConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (sessionStorage.getItem(STORAGE_KEY)) return;
    api
      .get<{ consented: boolean }>('/research/status')
      .then(({ consented }) => {
        if (!consented) setNeedsConsent(true);
        else sessionStorage.setItem(STORAGE_KEY, '1');
      })
      .catch(() => {
        /* study module unreachable — don't block product usage */
      });
  }, [user]);

  if (!needsConsent) return null;

  async function accept() {
    setSubmitting(true);
    try {
      await api.post('/research/consent');
      sessionStorage.setItem(STORAGE_KEY, '1');
      setNeedsConsent(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="glass max-w-md p-6">
        <div className="font-display text-lg font-semibold text-paper">
          Before you start
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-muted">
          Simulyn is being evaluated as part of a student research study. Using it during
          this period means your in-app activity (submissions, timings, and proctoring
          events) is logged and may appear, in de-identified form, in a research paper.
          No names or emails are included in any export. You can stop using the platform
          at any time.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          By continuing, you confirm you're 18+ (or have instructor/guardian permission)
          and agree to take part.
        </p>
        <Button className="mt-5 w-full justify-center" onClick={accept} loading={submitting}>
          I agree — continue
        </Button>
      </div>
    </div>
  );
}
```

### 1h. New file — `apps/web/src/app/student/survey/page.tsx`

```tsx
'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageTransition } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/panel';
import { api } from '@/lib/api';

// Standard 10-item System Usability Scale. Odd items are phrased positively,
// even items negatively — that alternation is part of the instrument, not a
// mistake, and the scoring in the backend accounts for it.
const ITEMS = [
  'I think that I would like to use Simulyn frequently.',
  'I found Simulyn unnecessarily complex.',
  'I thought Simulyn was easy to use.',
  'I think I would need help from a technical person to use Simulyn.',
  'I found the various functions in Simulyn well integrated.',
  'I thought there was too much inconsistency in Simulyn.',
  'I would imagine most people would learn to use Simulyn very quickly.',
  'I found Simulyn very cumbersome/awkward to use.',
  'I felt very confident using Simulyn.',
  'I needed to learn a lot of things before I could get going with Simulyn.',
];

const SCALE = [1, 2, 3, 4, 5];

export default function SurveyPage() {
  const [answers, setAnswers] = useState<(number | null)[]>(Array(10).fill(null));
  const [freeText, setFreeText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .get<{ surveyed: boolean }>('/research/status')
      .then(({ surveyed }) => setDone(surveyed))
      .catch(() => setDone(false));
  }, []);

  const complete = answers.every((a) => a !== null);

  async function submit() {
    if (!complete) return;
    setSubmitting(true);
    try {
      await api.post('/research/survey', { susAnswers: answers, freeText: freeText || undefined });
      setDone(true);
      toast.success('Thanks — your feedback was recorded.');
    } catch {
      toast.error('Could not submit right now. Try again in a bit.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageTransition>
      <div className="mx-auto max-w-2xl">
        <Panel>
          <PanelHeader label="Research study" title="A few questions before you go" />
          <PanelBody className="space-y-6">
            {done ? (
              <p className="text-sm text-muted">
                You've already submitted this survey — thanks for taking part in the study.
              </p>
            ) : (
              <>
                <p className="text-[13px] text-muted">
                  This is a standard usability questionnaire (SUS) for the Simulyn evaluation
                  study. 1 = strongly disagree, 5 = strongly agree. Takes about 2 minutes.
                </p>

                {ITEMS.map((item, i) => (
                  <div key={i} className="border-t border-line pt-4 first:border-0 first:pt-0">
                    <div className="text-[13px] text-paper">
                      {i + 1}. {item}
                    </div>
                    <div className="mt-2 flex gap-2">
                      {SCALE.map((v) => (
                        <button
                          key={v}
                          onClick={() =>
                            setAnswers((prev) => prev.map((a, idx) => (idx === i ? v : a)))
                          }
                          className={`h-9 w-9 rounded-md border text-[13px] transition-colors ${
                            answers[i] === v
                              ? 'border-violet-lit bg-violet/20 text-paper'
                              : 'border-line text-muted hover:border-line-strong'
                          }`}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}

                <div className="border-t border-line pt-4">
                  <label className="text-[13px] text-paper">
                    Anything else you'd like to tell us? (optional)
                  </label>
                  <textarea
                    value={freeText}
                    onChange={(e) => setFreeText(e.target.value)}
                    rows={3}
                    className="mt-2 w-full rounded-lg border border-line bg-black/20 p-3 text-[13px] text-paper outline-none focus:border-violet-lit/60"
                  />
                </div>

                <Button
                  className="w-full justify-center"
                  disabled={!complete}
                  loading={submitting}
                  onClick={submit}
                >
                  Submit
                </Button>
              </>
            )}
          </PanelBody>
        </Panel>
      </div>
    </PageTransition>
  );
}
```

### 1i. Wire consent gate + font/provider into root layout — `apps/web/src/app/layout.tsx`

- Import and render `<ConsentGate />` from `@/components/research/consent-gate` inside the body (alongside existing providers). (This step only needs the `ConsentGate` import/render — skip the `ThemeProvider`/font wiring here if you're not doing Feature 2.)

### 1j. Add nav link — `apps/web/src/app/student/layout.tsx`

Add a `ClipboardList` icon import from `lucide-react`, and add this entry to the student nav items array:
```ts
{ href: '/student/survey', label: 'Feedback survey', icon: ClipboardList },
```

---

## Feature 2 — Theme customizer

### 2a. New file — `apps/web/src/lib/themes.ts`

```ts
// Theme presets: each overrides the accent CSS custom properties set in globals.css.
// "instrument" is the existing violet/brass lab-bench default; the rest are
// user-selectable palettes for the theme customizer.
export interface ThemePreset {
  id: string;
  label: string;
  vars: Record<string, string>;
}

export const THEMES: ThemePreset[] = [
  {
    id: 'instrument',
    label: 'Instrument (default)',
    vars: {
      '--color-violet': '#7352b8',
      '--color-violet-lit': '#a78bfa',
      '--color-violet-dim': '#2a2142',
      '--color-brass': '#c7a346',
      '--color-brass-lit': '#e8cc80',
      '--color-brass-dim': '#33291163',
    },
  },
  {
    id: 'purple-gold',
    label: 'Purple / Gold',
    vars: {
      '--color-violet': '#5b3fa6',
      '--color-violet-lit': '#b57bff',
      '--color-violet-dim': '#1a0d3d',
      '--color-brass': '#c7a346',
      '--color-brass-lit': '#f5e4b0',
      '--color-brass-dim': '#33291163',
    },
  },
  {
    id: 'graphite',
    label: 'Graphite',
    vars: {
      '--color-violet': '#5a6478',
      '--color-violet-lit': '#a9b4c9',
      '--color-violet-dim': '#22262f',
      '--color-brass': '#8f8f8f',
      '--color-brass-lit': '#d4d4d4',
      '--color-brass-dim': '#2a2a2a63',
    },
  },
  {
    id: 'emerald',
    label: 'Emerald / Brass',
    vars: {
      '--color-violet': '#2f8f6b',
      '--color-violet-lit': '#5eead4',
      '--color-violet-dim': '#123028',
      '--color-brass': '#c7a346',
      '--color-brass-lit': '#e8cc80',
      '--color-brass-dim': '#33291163',
    },
  },
];

export const THEME_STORAGE_KEY = 'simulyn.theme';
export const DEFAULT_THEME_ID = THEMES[0].id;

export function applyTheme(themeId: string) {
  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }
  root.dataset.theme = theme.id;
}
```

### 2b. New file — `apps/web/src/hooks/useTheme.tsx`

```tsx
'use client';

import { createContext, useContext, useEffect, useState } from 'react';

import { applyTheme, DEFAULT_THEME_ID, THEME_STORAGE_KEY } from '@/lib/themes';

interface ThemeContextValue {
  themeId: string;
  setThemeId: (id: string) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  themeId: DEFAULT_THEME_ID,
  setThemeId: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeIdState] = useState(DEFAULT_THEME_ID);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY) ?? DEFAULT_THEME_ID;
    setThemeIdState(stored);
    applyTheme(stored);
  }, []);

  function setThemeId(id: string) {
    setThemeIdState(id);
    window.localStorage.setItem(THEME_STORAGE_KEY, id);
    applyTheme(id);
  }

  return (
    <ThemeContext.Provider value={{ themeId, setThemeId }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
```

### 2c. New file — `apps/web/src/components/brand/theme-switcher.tsx`

```tsx
'use client';

import { Palette } from 'lucide-react';
import { useState } from 'react';

import { useTheme } from '@/hooks/useTheme';
import { THEMES } from '@/lib/themes';
import { cn } from '@/lib/utils';

export function ThemeSwitcher() {
  const { themeId, setThemeId } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-muted transition-colors hover:text-paper"
        title="Customize theme"
        aria-label="Customize theme"
      >
        <Palette className="h-4 w-4" />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="glass absolute right-0 z-50 mt-2 w-52 p-2">
            <div className="instrument px-2 py-1.5">Theme</div>
            {THEMES.map((theme) => (
              <button
                key={theme.id}
                onClick={() => {
                  setThemeId(theme.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-[13px] transition-colors hover:bg-white/5',
                  themeId === theme.id ? 'text-paper' : 'text-muted',
                )}
              >
                <span
                  className="h-3.5 w-3.5 shrink-0 rounded-full"
                  style={{
                    background: `linear-gradient(135deg, ${theme.vars['--color-violet-lit']}, ${theme.vars['--color-brass-lit']})`,
                  }}
                />
                {theme.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
```

### 2d. Wrap the app in `ThemeProvider` — `apps/web/src/app/layout.tsx`

Import `ThemeProvider` from `@/hooks/useTheme` and wrap the existing body content (including `<ConsentGate />` if you did Feature 1) inside `<ThemeProvider>...</ThemeProvider>`.

### 2e. Add the switcher to the UI

- In `apps/web/src/app/page.tsx` (landing page header): import `ThemeSwitcher` from `@/components/brand/theme-switcher` and render it next to the "Sign in" button.
- In `apps/web/src/components/layout/app-shell.tsx` (main app shell): import and render `<ThemeSwitcher />` in the top bar next to the other header controls.

---

## Feature 3 — Visual/branding polish (Syne wordmark + landing page orbs)

### 3a. Add the Syne font — `apps/web/src/app/layout.tsx`

Change the font import:
```ts
import { Inter, JetBrains_Mono, Syne } from 'next/font/google';
```

Add the font instance (alongside the existing `inter`/`jetbrains` instances):
```ts
const syne = Syne({
  subsets: ['latin'],
  variable: '--font-syne',
  display: 'swap',
});
```

Add the font's CSS variable to the `<html>` className:
```tsx
<html lang="en" className={`${inter.variable} ${jetbrains.variable} ${syne.variable}`}>
```

### 3b. New CSS — `apps/web/src/app/globals.css`

Add the display-font variable near the other `--font-*` variables:
```css
--font-display: var(--font-syne), var(--font-sans);
```

Add these rules/classes (append inside the existing `@layer` block they belong to, alongside similar utility classes):
```css
/* SIMULYN wordmark: violet -> paper -> brass sweep, Syne display face. */
.brand-mark {
  font-family: var(--font-display);
  background: linear-gradient(
    90deg,
    var(--color-violet-lit) 0%,
    var(--color-violet-lit) 15%,
    var(--color-paper) 40%,
    var(--color-paper) 60%,
    var(--color-brass-lit) 85%,
    var(--color-brass-lit) 100%
  );
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
}

.font-display {
  font-family: var(--font-display);
}

/* Ambient bench orbs for the landing page background. */
.orb-field {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}
.orb {
  position: absolute;
  border-radius: 999px;
  filter: blur(2px);
}
.orb-1 {
  width: 600px;
  height: 600px;
  top: -10%;
  left: -8%;
  background: radial-gradient(circle, color-mix(in srgb, var(--color-violet) 28%, transparent) 0%, transparent 70%);
  animation: orb-drift-1 26s ease-in-out infinite alternate;
}
.orb-2 {
  width: 500px;
  height: 500px;
  bottom: -5%;
  right: -5%;
  background: radial-gradient(circle, color-mix(in srgb, var(--color-brass) 16%, transparent) 0%, transparent 70%);
  animation: orb-drift-2 32s ease-in-out infinite alternate;
}
.orb-3 {
  width: 400px;
  height: 400px;
  top: 40%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: radial-gradient(circle, color-mix(in srgb, var(--color-violet) 10%, transparent) 0%, transparent 70%);
  animation: orb-drift-3 20s ease-in-out infinite alternate;
}
@keyframes orb-drift-1 {
  to {
    transform: translate(40px, 30px) scale(1.06);
  }
}
@keyframes orb-drift-2 {
  to {
    transform: translate(-30px, -40px) scale(1.08);
  }
}
@keyframes orb-drift-3 {
  to {
    transform: translate(-50%, -50%) translate(20px, -20px) scale(1.04);
  }
}
```

### 3c. Landing page — `apps/web/src/app/page.tsx`

- Add the orb field as the first element inside the page's root container:
  ```tsx
  <div className="orb-field">
    <div className="orb orb-1" />
    <div className="orb orb-2" />
    <div className="orb orb-3" />
  </div>
  ```
- Add `relative z-10` to the `<header>` className so it sits above the orbs (`className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-6"`).
- Replace every plain `SIMULYN` wordmark span with the gradient treatment, e.g.:
  ```tsx
  <span className="brand-mark text-lg font-semibold tracking-[-0.03em]">SIMULYN</span>
  ```
  and the footer wordmark:
  ```tsx
  <span className="brand-mark font-mono text-[11px]">SIMULYN</span>
  ```
- Add `font-display` to the hero `<h1>` className.
- Replace the hero's gradient `<span>` (currently `bg-gradient-to-r from-violet-lit via-paper to-brass-lit bg-clip-text text-transparent`) with the shared class:
  ```tsx
  <span className="brand-mark">without the lab.</span>
  ```

### 3d. App shell — `apps/web/src/components/layout/app-shell.tsx`

Replace the plain SIMULYN wordmark div with the gradient treatment:
```tsx
<div className="brand-mark text-sm font-semibold tracking-[-0.02em]">SIMULYN</div>
```

---

## Setup commands to run after creating the files

```bash
pnpm add archiver@^7.0.1 --filter @simulyn/api
pnpm add -D @types/archiver@^6.0.4 --filter @simulyn/api
pnpm db:generate
pnpm db:migrate   # or db:push in dev — creates the StudyConsent / SurveyResponse tables
pnpm build
```

Do not touch the code execution engine, proctoring logic, or gamification modules — this task is scoped to the three features above only.
