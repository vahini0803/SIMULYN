import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@simulyn/shared';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { FlagAttemptDto, QueryViolationsDto, RecordViolationDto } from './dto/violation.dto';
import { ProctoringGateway, teacherRoom } from './proctoring.gateway';
import { ProctoringService } from './proctoring.service';

@ApiTags('proctoring')
@ApiBearerAuth()
@Controller('proctoring')
export class ProctoringController {
  constructor(
    private readonly proctoring: ProctoringService,
    private readonly gateway: ProctoringGateway,
  ) {}

  @Post('violations')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Record a violation and deduct from the attempt’s integrity score',
    description: 'REST fallback for clients without a live socket — it broadcasts to the proctor room too.',
  })
  async record(@Body() dto: RecordViolationDto, @CurrentUser() user: AuthenticatedUser) {
    const recorded = await this.proctoring.record(dto, user);
    this.gateway.server?.to(teacherRoom(recorded.examId)).emit('student-violation', recorded);
    return recorded;
  }

  @Get('violations')
  @ApiOperation({ summary: 'List violations (students see only their own)' })
  list(@Query() query: QueryViolationsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.proctoring.list(query, user);
  }

  @Get('exams/:examId/live')
  @Roles(Role.TEACHER, Role.ADMIN)
  @ApiOperation({ summary: 'Snapshot of every attempt for the live proctor grid' })
  live(@Param('examId') examId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.proctoring.liveBoard(examId, user);
  }

  @Post('attempts/:attemptId/flag')
  @Roles(Role.TEACHER, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Record a proctor note against an attempt',
    description: 'Stored as a zero-weight MANUAL violation, so notes sit on the same timeline.',
  })
  async flag(
    @Param('attemptId') attemptId: string,
    @Body() dto: FlagAttemptDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const recorded = await this.proctoring.flag(attemptId, dto.note, user);
    this.gateway.server?.to(teacherRoom(recorded.examId)).emit('student-violation', recorded);
    return recorded;
  }

  @Get('attempts/:attemptId/notes')
  @Roles(Role.TEACHER, Role.ADMIN)
  @ApiOperation({ summary: 'Proctor notes recorded against an attempt' })
  notes(@Param('attemptId') attemptId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.proctoring.notes(attemptId, user);
  }
}
