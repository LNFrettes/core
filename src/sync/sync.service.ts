import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnkiConnectClient } from './anki-connect.client';
import { NotionAnkiMapper } from './notion-anki.mapper';
import { NotionSyncClient } from './notion-sync.client';
import { SupabasePagesRepository } from './supabase-pages.repository';
import type {
  PageSyncStats,
  ReformatPageStats,
  ReformatRunReport,
  SyncRunReport,
} from './sync.types';

@Injectable()
export class SyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SyncService.name);
  private isRunning = false;
  private lastRun: SyncRunReport | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly pagesRepository: SupabasePagesRepository,
    private readonly notionClient: NotionSyncClient,
    private readonly mapper: NotionAnkiMapper,
    private readonly ankiClient: AnkiConnectClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const startupEnabled =
      this.configService.get<string>('SYNC_STARTUP_ENABLED') ?? 'true';

    if (startupEnabled.toLowerCase() === 'false') {
      this.logger.log('Sync de arranque deshabilitado por configuración.');
      return;
    }

    try {
      await this.runSync('startup');
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(
          `Falló sync de arranque: ${error.message}`,
          error.stack,
        );
      } else {
        this.logger.error('Falló sync de arranque con error desconocido.');
      }
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async runScheduledSync(): Promise<void> {
    const cronEnabled =
      this.configService.get<string>('SYNC_CRON_ENABLED') ?? 'true';
    if (cronEnabled.toLowerCase() === 'false') {
      return;
    }

    await this.runSync('cron');
  }

  async runManualSync(): Promise<SyncRunReport> {
    return this.runSync('manual');
  }

  async runManualReformat(): Promise<ReformatRunReport> {
    return this.runReformat();
  }

  getStatus(): { running: boolean; lastRun: SyncRunReport | null } {
    return {
      running: this.isRunning,
      lastRun: this.lastRun,
    };
  }

  async getDependenciesHealth(): Promise<{ ankiReachable: boolean }> {
    const ankiReachable = await this.ankiClient.healthcheck();
    return { ankiReachable };
  }

  private async runSync(
    trigger: 'cron' | 'manual' | 'startup',
  ): Promise<SyncRunReport> {
    if (this.isRunning) {
      this.logger.warn(
        'Se omite corrida porque el proceso anterior sigue ejecutándose.',
      );
      return this.buildLockedSyncReport(trigger);
    }

    this.isRunning = true;
    const startedAt = new Date();
    this.logger.log(`Iniciando sync ${trigger}...`);

    const report: SyncRunReport = {
      trigger,
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      pagesRead: 0,
      togglesRead: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      failed: 0,
      pageStats: [],
    };

    try {
      const pages = await this.pagesRepository.listEnabledPages();
      report.pagesRead = pages.length;
      this.logger.log(`Se encontraron ${pages.length} páginas habilitadas.`);

      for (const page of pages) {
        const pageStats = await this.syncSinglePage(page);
        report.pageStats.push(pageStats);
      }

      this.aggregate(report);
    } finally {
      this.isRunning = false;
      report.finishedAt = new Date().toISOString();
      this.lastRun = report;
      this.logger.log(
        `Sync ${trigger} finalizada. Páginas=${report.pagesRead}, creadas=${report.created}, actualizadas=${report.updated}, eliminadas=${report.deleted}, fallidas=${report.failed}`,
      );
    }

    return report;
  }

  private async runReformat(): Promise<ReformatRunReport> {
    if (this.isRunning) {
      this.logger.warn(
        'Se omite reformat porque el proceso anterior sigue ejecutándose.',
      );

      const now = new Date().toISOString();
      return {
        trigger: 'manual',
        startedAt: now,
        finishedAt: now,
        pagesRead: 0,
        notesTargeted: 0,
        reformatted: 0,
        unchanged: 0,
        missing: 0,
        failed: 1,
        pageStats: [
          {
            notionPageId: 'n/a',
            deckName: 'n/a',
            notesTargeted: 0,
            reformatted: 0,
            unchanged: 0,
            missing: 0,
            failed: 1,
            errors: ['Reformat omitido por lock anti-solapamiento'],
          },
        ],
      };
    }

    this.isRunning = true;
    const startedAt = new Date();
    this.logger.log('Iniciando reformat manual...');

    const report: ReformatRunReport = {
      trigger: 'manual',
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      pagesRead: 0,
      notesTargeted: 0,
      reformatted: 0,
      unchanged: 0,
      missing: 0,
      failed: 0,
      pageStats: [],
    };

    try {
      const pages = await this.pagesRepository.listEnabledPages();
      report.pagesRead = pages.length;
      this.logger.log(
        `Reformat: se encontraron ${pages.length} páginas habilitadas.`,
      );

      for (const page of pages) {
        this.logger.log(
          `Reformat página ${page.notionPageId}: inicio (deck=${page.deckName}, deckId=${page.ankiDeckId ?? 'n/a'})`,
        );

        const pageStats: ReformatPageStats = {
          notionPageId: page.notionPageId,
          deckName: page.deckName,
          notesTargeted: 0,
          reformatted: 0,
          unchanged: 0,
          missing: 0,
          failed: 0,
          errors: [],
        };

        try {
          this.logger.log(
            `Reformat página ${page.notionPageId}: resolviendo deck binding...`,
          );

          const deckBinding =
            page.ankiDeckId == null
              ? await this.resolveAndPersistMissingDeckId(page)
              : await this.resolveAndRefreshDeckBinding(page);

          const pageWithResolvedDeck = {
            ...page,
            deckName: deckBinding.resolvedDeckName,
            ankiDeckId: deckBinding.resolvedDeckId,
          };
          pageStats.deckName = deckBinding.resolvedDeckName;

          this.logger.log(
            `Reformat página ${page.notionPageId}: deck binding resuelto (deck=${deckBinding.resolvedDeckName}, deckId=${deckBinding.resolvedDeckId})`,
          );

          this.logger.log(
            `Reformat página ${page.notionPageId}: obteniendo toggles desde Notion...`,
          );

          const toggles = await this.notionClient.getPageToggles(
            page.notionPageId,
          );

          this.logger.log(
            `Reformat página ${page.notionPageId}: toggles obtenidos=${toggles.length}, mapeando a notas...`,
          );

          const mapped = toggles.map((toggle) =>
            this.mapper.mapToggle(pageWithResolvedDeck, toggle),
          );
          pageStats.notesTargeted = mapped.length;

          this.logger.log(
            `Reformat página ${page.notionPageId}: target_notas=${mapped.length}, deck=${deckBinding.resolvedDeckName}`,
          );

          this.logger.log(
            `Reformat página ${page.notionPageId}: iniciando reformat en Anki...`,
          );

          await (
            this.ankiClient as unknown as {
              reformatPage: (
                stats: ReformatPageStats,
                notes: typeof mapped,
              ) => Promise<ReformatPageStats>;
            }
          ).reformatPage(pageStats, mapped);

          this.logger.log(
            `Reformat página ${page.notionPageId}: reformat en Anki finalizado.`,
          );
        } catch (error) {
          pageStats.failed += 1;
          const message =
            error instanceof Error
              ? error.message
              : 'Error desconocido durante reformat de página';
          pageStats.errors.push(message);

          if (error instanceof Error) {
            this.logger.error(
              `Error reformat página ${page.notionPageId}: ${error.message}`,
              error.stack,
            );
          } else {
            this.logger.error(
              `Error reformat página ${page.notionPageId}: ${message}`,
            );
          }
        }

        this.logger.log(
          `Reformat página ${page.notionPageId}: reformatted=${pageStats.reformatted}, unchanged=${pageStats.unchanged}, missing=${pageStats.missing}, failed=${pageStats.failed}`,
        );

        report.pageStats.push(pageStats);
      }

      this.aggregateReformat(report);
    } finally {
      this.isRunning = false;
      report.finishedAt = new Date().toISOString();
      this.logger.log(
        `Reformat finalizado. Páginas=${report.pagesRead}, target=${report.notesTargeted}, reformateadas=${report.reformatted}, sin_cambios=${report.unchanged}, faltantes=${report.missing}, fallidas=${report.failed}`,
      );
    }

    return report;
  }

  private aggregate(report: SyncRunReport): void {
    for (const page of report.pageStats) {
      report.togglesRead += page.togglesRead;
      report.created += page.created;
      report.updated += page.updated;
      report.unchanged += page.unchanged;
      report.deleted += page.deleted;
      report.failed += page.failed;
    }
  }

  private async syncSinglePage(page: {
    id: string;
    notionPageId: string;
    deckName: string;
    ankiDeckId: number | null;
    enabled: boolean;
    updatedAt: string;
  }): Promise<PageSyncStats> {
    this.logger.log(
      `Sync de página iniciada. notionPageId=${page.notionPageId}, deck=${page.deckName}, deckId=${page.ankiDeckId ?? 'n/a'}`,
    );

    const pageStats: PageSyncStats = {
      notionPageId: page.notionPageId,
      deckName: page.deckName,
      togglesRead: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      failed: 0,
      errors: [],
    };

    try {
      const deckBinding =
        page.ankiDeckId == null
          ? await this.resolveAndPersistMissingDeckId(page)
          : await this.resolveAndRefreshDeckBinding(page);

      const pageWithResolvedDeck = {
        ...page,
        deckName: deckBinding.resolvedDeckName,
        ankiDeckId: deckBinding.resolvedDeckId,
      };
      pageStats.deckName = deckBinding.resolvedDeckName;

      const toggles = await this.notionClient.getPageToggles(page.notionPageId);
      pageStats.togglesRead = toggles.length;
      this.logger.log(
        `Página ${page.notionPageId}: toggles encontrados=${toggles.length}`,
      );

      const mapped = toggles.map((toggle) =>
        this.mapper.mapToggle(pageWithResolvedDeck, toggle),
      );
      this.logger.log(
        `Página ${page.notionPageId}: notas mapeadas=${mapped.length}, deck_resuelto=${deckBinding.resolvedDeckName}, deck_id=${deckBinding.resolvedDeckId}`,
      );

      await this.ankiClient.syncPage(pageStats, mapped);
    } catch (error) {
      pageStats.failed += 1;
      const message =
        error instanceof Error
          ? error.message
          : 'Error desconocido de sincronización de página';
      pageStats.errors.push(message);

      if (error instanceof Error) {
        this.logger.error(
          `Error sincronizando página ${page.notionPageId}: ${error.message}`,
          error.stack,
        );
      } else {
        this.logger.error(
          `Error sincronizando página ${page.notionPageId}: ${message}`,
        );
      }
    }

    if (pageStats.failed > 0) {
      this.logger.warn(
        `Página ${page.notionPageId} finalizó con errores. failed=${pageStats.failed}, errors=${JSON.stringify(pageStats.errors)}`,
      );
      return pageStats;
    }

    this.logger.log(
      `Página ${page.notionPageId} OK. creadas=${pageStats.created}, actualizadas=${pageStats.updated}, sin cambios=${pageStats.unchanged}, eliminadas=${pageStats.deleted}`,
    );
    return pageStats;
  }

  private buildLockedSyncReport(
    trigger: 'cron' | 'manual' | 'startup',
  ): SyncRunReport {
    const now = new Date().toISOString();
    return {
      trigger,
      startedAt: now,
      finishedAt: now,
      pagesRead: 0,
      togglesRead: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      failed: 1,
      pageStats: [
        {
          notionPageId: 'n/a',
          deckName: 'n/a',
          togglesRead: 0,
          created: 0,
          updated: 0,
          unchanged: 0,
          deleted: 0,
          failed: 1,
          errors: ['Corrida omitida por lock anti-solapamiento'],
        },
      ],
    };
  }

  private aggregateReformat(report: ReformatRunReport): void {
    for (const page of report.pageStats) {
      report.notesTargeted += page.notesTargeted;
      report.reformatted += page.reformatted;
      report.unchanged += page.unchanged;
      report.missing += page.missing;
      report.failed += page.failed;
    }
  }

  private async resolveAndPersistMissingDeckId(page: {
    id: string;
    notionPageId: string;
    deckName: string;
    ankiDeckId: number | null;
  }): Promise<{ resolvedDeckName: string; resolvedDeckId: number }> {
    this.logger.log(
      `Página ${page.notionPageId}: no tiene deck_id, buscando id por nombre '${page.deckName}'.`,
    );

    const deckBinding = await this.ankiClient.resolveDeckBinding(
      page.deckName,
      null,
    );

    await this.pagesRepository.updateDeckBinding(
      page.id,
      deckBinding.resolvedDeckId,
      deckBinding.resolvedDeckName,
    );

    this.logger.log(
      `Página ${page.notionPageId}: deck binding guardado (deck='${deckBinding.resolvedDeckName}', id=${deckBinding.resolvedDeckId}).`,
    );

    return deckBinding;
  }

  private async resolveAndRefreshDeckBinding(page: {
    id: string;
    notionPageId: string;
    deckName: string;
    ankiDeckId: number | null;
  }): Promise<{ resolvedDeckName: string; resolvedDeckId: number }> {
    const deckBinding = await this.ankiClient.resolveDeckBinding(
      page.deckName,
      page.ankiDeckId,
    );

    if (
      page.ankiDeckId !== deckBinding.resolvedDeckId ||
      page.deckName !== deckBinding.resolvedDeckName
    ) {
      await this.pagesRepository.updateDeckBinding(
        page.id,
        deckBinding.resolvedDeckId,
        deckBinding.resolvedDeckName,
      );

      this.logger.log(
        `Página ${page.notionPageId}: deck binding actualizado (deck='${page.deckName}' -> '${deckBinding.resolvedDeckName}', id=${page.ankiDeckId ?? 'n/a'} -> ${deckBinding.resolvedDeckId}).`,
      );
    }

    return deckBinding;
  }
}
