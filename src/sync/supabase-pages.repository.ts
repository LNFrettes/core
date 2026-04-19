import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { SyncPageRecord } from './sync.types';

interface RawSupabaseSyncPage {
  id: string;
  notion_page_id: string;
  deck_name: string;
  anki_deck_id: number | null;
  enabled: boolean;
  updated_at: string;
}

@Injectable()
export class SupabasePagesRepository {
  private readonly client: ReturnType<typeof createClient>;
  private readonly tableName: string;

  constructor(private readonly configService: ConfigService) {
    const supabaseUrl =
      this.configService.get<string>('SUPABASE_URL')?.trim() ?? '';
    const supabaseServiceRoleKey =
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY')?.trim() ?? '';

    if (supabaseUrl.length === 0) {
      throw new Error(
        'SUPABASE_URL no está definida o está vacía. Verificá el archivo .env de core.',
      );
    }

    if (supabaseServiceRoleKey.length === 0) {
      throw new Error(
        'SUPABASE_SERVICE_ROLE_KEY no está definida o está vacía. Verificá el archivo .env de core.',
      );
    }

    this.tableName =
      this.configService.get<string>('SUPABASE_SYNC_TABLE') ??
      'notion_sync_pages';
    this.client = createClient(supabaseUrl, supabaseServiceRoleKey);
  }

  async listEnabledPages(): Promise<SyncPageRecord[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select(
        'id, notion_page_id, deck_name, anki_deck_id, enabled, updated_at',
      )
      .eq('enabled', true)
      .order('updated_at', { ascending: false });

    if (error != null) {
      throw new Error(
        `No se pudieron obtener páginas habilitadas desde Supabase: ${error.message}`,
      );
    }

    return (data as RawSupabaseSyncPage[]).map((row) => ({
      id: row.id,
      notionPageId: row.notion_page_id,
      deckName: row.deck_name,
      ankiDeckId: row.anki_deck_id,
      enabled: row.enabled,
      updatedAt: row.updated_at,
    }));
  }

  async updateDeckBinding(
    pageId: string,
    ankiDeckId: number,
    deckName: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .update({ anki_deck_id: ankiDeckId, deck_name: deckName } as never)
      .eq('id', pageId);

    if (error != null) {
      throw new Error(
        `No se pudo actualizar deck binding para la página ${pageId}: ${error.message}`,
      );
    }
  }
}
