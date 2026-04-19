import { Module } from '@nestjs/common';
import { AnkiConnectClient } from './anki-connect.client';
import { NotionAnkiMapper } from './notion-anki.mapper';
import { NotionSyncClient } from './notion-sync.client';
import { SupabasePagesRepository } from './supabase-pages.repository';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  controllers: [SyncController],
  providers: [
    SyncService,
    SupabasePagesRepository,
    NotionSyncClient,
    NotionAnkiMapper,
    AnkiConnectClient,
  ],
})
export class SyncModule {}
