import { NotionAnkiMapper } from './notion-anki.mapper';
import { SyncService } from './sync.service';

describe('SyncService', () => {
  it('omite ejecución manual cuando hay una corrida en progreso', async () => {
    const service = new SyncService(
      { get: jest.fn() } as never,
      { listEnabledPages: jest.fn() } as never,
      { getPageToggles: jest.fn() } as never,
      new NotionAnkiMapper(),
      { syncPage: jest.fn(), healthcheck: jest.fn() } as never,
    );

    (service as unknown as { isRunning: boolean }).isRunning = true;

    const report = await service.runManualSync();

    expect(report.failed).toBe(1);
    expect(report.pageStats[0]?.errors[0]).toContain('lock anti-solapamiento');
  });
});
