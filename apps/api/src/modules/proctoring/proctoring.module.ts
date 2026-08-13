import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProctoringController } from './proctoring.controller';
import { ProctoringGateway } from './proctoring.gateway';
import { ProctoringService } from './proctoring.service';

@Module({
  imports: [AuthModule],
  controllers: [ProctoringController],
  providers: [ProctoringService, ProctoringGateway],
  exports: [ProctoringService, ProctoringGateway],
})
export class ProctoringModule {}
