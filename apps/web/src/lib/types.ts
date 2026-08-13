/** Response shapes returned by the SIMULYN API (apps/api). */

export type Role = 'STUDENT' | 'TEACHER' | 'ADMIN';
export type ProblemType = 'PROGRAMMING' | 'ELECTRONICS';
export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type LanguageEnum = 'PYTHON' | 'JAVASCRIPT' | 'CPP' | 'JAVA';
export type LangKey = 'python' | 'javascript' | 'cpp' | 'java';

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  avatar: string | null;
  role: Role;
  mustChangePassword: boolean;
}

export interface AuthResponse {
  accessToken: string;
  user: AuthUser;
}

export interface Paginated<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export interface ProblemExample {
  input: string;
  output: string;
  explanation?: string;
}

export interface ElectronicsQuestion {
  id: string;
  text: string;
  answer?: number;
  tolerance: number;
  unit?: string;
}

export interface TestCaseView {
  id: string;
  input: string;
  expected: string;
  isHidden: boolean;
  order: number;
}

export interface Problem {
  id: string;
  type: ProblemType;
  difficulty: Difficulty;
  category: string;
  title: string;
  description: string;
  constraints: string[];
  points: number;
  tags: string[];
  isPublished: boolean;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  starterCode: Partial<Record<LangKey, string>> | null;
  harness: unknown;
  examples: ProblemExample[] | null;
  params: Record<string, unknown> | null;
  questions: ElectronicsQuestion[] | null;
  testCases?: TestCaseView[];
  hints?: { id: string; level: number; text: string }[];
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  compileError: string | null;
  executionMs: number;
}

export interface TestOutcome {
  index: number;
  isHidden: boolean;
  input: string;
  expected: string;
  actual: string | null;
  passed: boolean;
  stderr: string | null;
  exitCode: number | null;
  timedOut: boolean;
  executionMs: number;
}

export interface EvaluationResult {
  ok: boolean;
  allPassed: boolean;
  compileError: string | null;
  results: TestOutcome[];
  passedCount: number;
  totalCount: number;
  totalMs: number;
}

export interface BadgeAward {
  key: string;
  name: string;
  icon: string;
  description: string;
}

export interface Reward {
  xp: number;
  xpAwarded: number;
  level: number;
  leveledUp: boolean;
  currentStreak: number;
  longestStreak: number;
  problemsSolved: number;
  newBadges: BadgeAward[];
}

export interface Submission {
  id: string;
  problemId: string;
  userId: string;
  examAttemptId: string | null;
  language: LanguageEnum;
  status: string;
  passed: boolean;
  score: number;
  maxScore: number;
  attemptNumber: number;
  compileError: string | null;
  executionMs: number | null;
  createdAt: string;
  passedCount: number;
  totalCount: number;
  testResults: Omit<TestOutcome, 'index'>[];
  reward: Reward | null;
  problemTitle?: string;
  code?: string;
}

export interface SubmissionListRow {
  id: string;
  problemId: string;
  userId: string;
  examAttemptId: string | null;
  language: LanguageEnum;
  status: string;
  passed: boolean;
  score: number;
  attemptNumber: number;
  executionMs: number | null;
  compileError: string | null;
  createdAt: string;
  problem: { title: string; difficulty: Difficulty; category: string; points: number };
  _count: { testResults: number };
}

export interface ElectronicsOutcome {
  questionId: string;
  text: string;
  expected: number;
  actual: number | null;
  tolerance: number;
  unit: string | null;
  correct: boolean;
}

export interface ElectronicsResult {
  allCorrect: boolean;
  score: number;
  correctCount: number;
  totalCount: number;
  results: ElectronicsOutcome[];
}

export interface GamificationMe {
  xp: number;
  level: number;
  levelThresholds: number[];
  xpToNextLevel: number | null;
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: string | null;
  problemsSolved: number;
  rank: number;
  badges: { key: string; name: string; description: string; icon: string; earnedAt: string }[];
}

export interface LeaderboardRow {
  rank: number;
  userId: string;
  username: string;
  displayName: string;
  avatar: string | null;
  xp: number;
  level: number;
  problemsSolved: number;
  currentStreak: number;
  isCurrentUser: boolean;
}

export interface BadgeRow {
  key: string;
  name: string;
  description: string;
  icon: string;
  condition: { type: string; threshold: number } | null;
  earned: boolean;
  earnedAt: string | null;
}

export interface ClassSummary {
  id: string;
  name: string;
  code: string;
  description: string | null;
  semester: string | null;
  teacherId: string;
  isArchived: boolean;
  createdAt: string;
  teacher: { id: string; username: string; displayName: string; avatar: string | null };
  _count: { enrollments: number; assignedProblems: number; exams: number };
}

export interface ExamSummary {
  id: string;
  classId: string;
  title: string;
  description: string | null;
  durationMin: number;
  scheduledStart: string;
  scheduledEnd: string;
  gracePeriodMin: number;
  isPublished: boolean;
  status: 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'COMPLETED';
  class: { id: string; name: string; code: string };
  _count: { problems: number; attempts: number };
  attempt: {
    id: string;
    startedAt: string;
    submittedAt: string | null;
    autoSubmitted: boolean;
    totalScore: number;
    integrityScore: number;
    endsAt: string;
  } | null;
}

export interface UserStats {
  userId: string;
  username: string;
  displayName: string;
  problemsSolved: number;
  totalSubmissions: number;
  passedSubmissions: number;
  accuracy: number;
  xp: number;
  level: number;
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: string | null;
}

export interface MentorHint {
  text: string;
  hintLevel: number;
  provider: string;
  cached: boolean;
  latencyMs: number;
}
