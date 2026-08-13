import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  INITIAL_INTEGRITY_SCORE,
  Prisma,
  Role,
  VIOLATION_TYPES,
  ViolationType,
  type ViolationTypeKey,
} from '@simulyn/shared';

import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { RecordViolationDto, QueryViolationsDto } from './dto/violation.dto';

export interface RecordedViolation {
  id: string;
  examAttemptId: string;
  examId: string;
  userId: string;
  username: string;
  displayName: string;
  typeKey: ViolationType;
  label: string;
  message: string;
  severity: string;
  critical: boolean;
  weight: number;
  timeRemaining: number | null;
  integrityScore: number;
  violationCount: number;
  createdAt: Date;
}

@Injectable()
export class ProctoringService {
  private readonly logger = new Logger(ProctoringService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a violation and deducts its weight from the attempt's integrity
   * score, which is floored at zero.
   */
  async record(dto: RecordViolationDto, actor: AuthenticatedUser): Promise<RecordedViolation> {
    const attempt = await this.prisma.examAttempt.findUnique({
      where: { id: dto.examAttemptId },
      include: {
        exam: { include: { class: { select: { teacherId: true } } } },
        user: { select: { id: true, username: true, displayName: true } },
      },
    });
    if (!attempt) throw new NotFoundException(`Exam attempt ${dto.examAttemptId} not found`);

    // Students may only report their own violations; staff may flag manually.
    if (actor.role === Role.STUDENT) {
      if (attempt.userId !== actor.id) {
        throw new ForbiddenException('That exam attempt belongs to another student');
      }
    } else if (actor.role === Role.TEACHER && attempt.exam.class.teacherId !== actor.id) {
      throw new ForbiddenException('You do not proctor this exam');
    }

    if (attempt.submittedAt) {
      throw new BadRequestException('This attempt has already been submitted');
    }

    const definition = VIOLATION_TYPES[dto.typeKey as ViolationTypeKey];
    const weight = dto.weight ?? definition?.weight ?? 0;
    const integrityScore = Math.max(0, attempt.integrityScore - weight);

    const [violation, updated, count] = await this.prisma.$transaction([
      this.prisma.violation.create({
        data: {
          examAttemptId: dto.examAttemptId,
          userId: attempt.userId,
          typeKey: dto.typeKey,
          weight,
          codeSnapshot: dto.codeSnapshot,
          timeRemaining: dto.timeRemaining,
          metadata: dto.metadata,
        },
      }),
      this.prisma.examAttempt.update({
        where: { id: dto.examAttemptId },
        data: { integrityScore },
      }),
      this.prisma.violation.count({ where: { examAttemptId: dto.examAttemptId } }),
    ]);

    this.logger.warn(
      `${attempt.user.username}: ${dto.typeKey} (-${weight}) → integrity ${integrityScore}`,
    );

    return {
      id: violation.id,
      examAttemptId: attempt.id,
      examId: attempt.examId,
      userId: attempt.userId,
      username: attempt.user.username,
      displayName: attempt.user.displayName,
      typeKey: dto.typeKey,
      label: definition?.label ?? dto.typeKey,
      message: (definition?.teacherAlert ?? '{name} triggered a violation').replace(
        '{name}',
        attempt.user.displayName,
      ),
      severity: definition?.severity ?? 'medium',
      critical: definition?.critical ?? false,
      weight,
      timeRemaining: dto.timeRemaining ?? null,
      integrityScore: updated.integrityScore,
      violationCount: count,
      createdAt: violation.createdAt,
    };
  }

  async list(query: QueryViolationsDto, requester: AuthenticatedUser) {
    const where: Prisma.ViolationWhereInput = {};
    if (query.examAttemptId) where.examAttemptId = query.examAttemptId;
    if (query.userId) where.userId = query.userId;
    if (query.typeKey) where.typeKey = query.typeKey;
    if (query.examId) where.examAttempt = { examId: query.examId };

    // Students only ever see their own record; teachers only their own exams.
    if (requester.role === Role.STUDENT) {
      where.userId = requester.id;
    } else if (requester.role === Role.TEACHER) {
      where.examAttempt = {
        ...(query.examId ? { examId: query.examId } : {}),
        exam: { class: { teacherId: requester.id } },
      };
    }

    const violations = await this.prisma.violation.findMany({
      where,
      include: {
        user: { select: { id: true, username: true, displayName: true, avatar: true } },
        examAttempt: { select: { id: true, examId: true, integrityScore: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    return violations.map((v) => {
      const definition = VIOLATION_TYPES[v.typeKey as ViolationTypeKey];
      return {
        id: v.id,
        examAttemptId: v.examAttemptId,
        examId: v.examAttempt.examId,
        user: v.user,
        typeKey: v.typeKey,
        label: definition?.label ?? v.typeKey,
        severity: definition?.severity ?? 'medium',
        critical: definition?.critical ?? false,
        weight: v.weight,
        timeRemaining: v.timeRemaining,
        integrityScore: v.examAttempt.integrityScore,
        codeSnapshot: requester.role === Role.STUDENT ? undefined : v.codeSnapshot,
        metadata: v.metadata,
        createdAt: v.createdAt,
      };
    });
  }

  /** Live board for the proctor view: one row per student who has started. */
  async liveBoard(examId: string, requester: AuthenticatedUser) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: { class: { select: { teacherId: true } } },
    });
    if (!exam) throw new NotFoundException(`Exam ${examId} not found`);
    if (requester.role === Role.TEACHER && exam.class.teacherId !== requester.id) {
      throw new ForbiddenException('You do not proctor this exam');
    }

    const attempts = await this.prisma.examAttempt.findMany({
      where: { examId },
      include: {
        user: { select: { id: true, username: true, displayName: true, avatar: true } },
        violations: { orderBy: { createdAt: 'desc' }, take: 5 },
        _count: { select: { violations: true, submissions: true } },
      },
    });

    return attempts.map((a) => ({
      attemptId: a.id,
      user: a.user,
      startedAt: a.startedAt,
      submittedAt: a.submittedAt,
      integrityScore: a.integrityScore,
      violationCount: a._count.violations,
      submissionCount: a._count.submissions,
      recentViolations: a.violations.map((v) => ({
        typeKey: v.typeKey,
        weight: v.weight,
        createdAt: v.createdAt,
      })),
    }));
  }

  get initialIntegrityScore(): number {
    return INITIAL_INTEGRITY_SCORE;
  }
}
