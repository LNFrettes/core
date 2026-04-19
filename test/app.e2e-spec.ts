import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(() => {
    process.env.NOTION_TOKEN = process.env.NOTION_TOKEN ?? 'test-token';
    process.env.SUPABASE_URL =
      process.env.SUPABASE_URL ?? 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'test-service-role-key';
    process.env.ANKI_CONNECT_URL =
      process.env.ANKI_CONNECT_URL ?? 'http://127.0.0.1:8765';
    process.env.SYNC_CRON_ENABLED = 'false';
  });

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('notion-anki-sync core running');
  });

  afterEach(async () => {
    await app.close();
  });
});
