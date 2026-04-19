import { Controller, Get, Post } from '@nestjs/common';
import { SyncService } from './sync.service';
import type { ReformatRunReport, SyncRunReport } from './sync.types';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get('status')
  getStatus() {
    return this.syncService.getStatus();
  }

  @Get('health')
  async getHealth() {
    const status = this.syncService.getStatus();
    const dependencies = await this.syncService.getDependenciesHealth();

    return {
      running: status.running,
      dependencies,
    };
  }

  @Post('run')
  async runManualSync(): Promise<SyncRunReport> {
    return this.syncService.runManualSync();
  }

  @Post('reformat')
  async runManualReformat(): Promise<ReformatRunReport> {
    return this.syncService.runManualReformat();
  }
}
