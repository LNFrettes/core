import { ConfigService } from '@nestjs/config';
import { AnkiConnectClient } from './anki-connect.client';
import type { MappedAnkiNote, PageSyncStats } from './sync.types';

function createClient(): AnkiConnectClient {
  return new AnkiConnectClient({
    get: jest.fn().mockReturnValue('http://127.0.0.1:8765'),
  } as unknown as ConfigService);
}

describe('AnkiConnectClient deduplicación', () => {
  it('deduplica por keyTag dentro de una página conservando el noteId más antiguo', async () => {
    const client = createClient();

    const invokeMock = jest
      .spyOn(client as never, 'invoke' as never)
      .mockImplementation(
        async (action: string, params?: Record<string, unknown>) => {
          if (action === 'findNotes') {
            expect(params).toEqual({ query: 'tag:na_sync_page_pagehash' });
            return [11, 5, 7, 13];
          }

          if (action === 'notesInfo') {
            return [
              { noteId: 11, tags: ['na_sync_key_a'] },
              { noteId: 5, tags: ['na_sync_key_a'] },
              { noteId: 7, tags: ['na_sync_key_b'] },
              { noteId: 13, tags: ['other_tag'] },
            ];
          }

          if (action === 'deleteNotes') {
            expect(params).toEqual({ notes: [11] });
            return null;
          }

          throw new Error(`Acción inesperada en test: ${action}`);
        },
      );

    const result = await (
      client as unknown as {
        deduplicatePageByKeyTag: (
          notionPageId: string,
          pageTag: string,
        ) => Promise<{
          strategy: string;
          conflictsFound: number;
          duplicatesRemoved: number;
          removedNoteIds: number[];
          conflicts: Array<{
            keyTag: string;
            keptNoteId: number;
            removedNoteIds: number[];
          }>;
        }>;
      }
    ).deduplicatePageByKeyTag('page-1', 'na_sync_page_pagehash');

    expect(result.strategy).toBe('oldest-note-id');
    expect(result.conflictsFound).toBe(1);
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.removedNoteIds).toEqual([11]);
    expect(result.conflicts).toEqual([
      {
        keyTag: 'na_sync_key_a',
        keptNoteId: 5,
        removedNoteIds: [11],
      },
    ]);

    expect(invokeMock).toHaveBeenCalledWith('findNotes', {
      query: 'tag:na_sync_page_pagehash',
    });
  });

  it('elimina duplicados cuando findByKeyTag encuentra múltiples coincidencias', async () => {
    const client = createClient();

    jest
      .spyOn(client as never, 'invoke' as never)
      .mockImplementation(
        async (action: string, params?: Record<string, unknown>) => {
          if (action === 'findNotes') {
            expect(params).toEqual({ query: 'tag:na_sync_key_dupe' });
            return [9, 4, 5];
          }

          if (action === 'deleteNotes') {
            expect(params).toEqual({ notes: [5, 9] });
            return null;
          }

          if (action === 'notesInfo') {
            expect(params).toEqual({ notes: [4] });
            return [{ noteId: 4, tags: ['na_sync_key_dupe'] }];
          }

          throw new Error(`Acción inesperada en test: ${action}`);
        },
      );

    const result = await (
      client as unknown as {
        findByKeyTag: (keyTag: string) => Promise<{ noteId: number } | null>;
      }
    ).findByKeyTag('na_sync_key_dupe');

    expect(result).toEqual({ noteId: 4, tags: ['na_sync_key_dupe'] });
  });

  it('ejecuta deduplicación automáticamente al iniciar syncPage', async () => {
    const client = createClient();

    const dedupSpy = jest
      .spyOn(client as never, 'deduplicatePageByKeyTag' as never)
      .mockResolvedValue({
        strategy: 'oldest-note-id',
        conflictsFound: 1,
        duplicatesRemoved: 1,
        removedNoteIds: [200],
        conflicts: [
          {
            keyTag: 'na_sync_key_a',
            keptNoteId: 100,
            removedNoteIds: [200],
          },
        ],
      });

    jest.spyOn(client as never, 'syncSingleNote' as never).mockResolvedValue({
      created: 0,
      updated: 0,
      unchanged: 1,
      failed: 0,
      errors: [],
    });

    jest.spyOn(client as never, 'syncDeletedNotes' as never).mockResolvedValue({
      deleted: 0,
      failed: 0,
      errors: [],
    });

    const pageStats: PageSyncStats = {
      notionPageId: 'page-abc',
      deckName: 'Deck Test',
      togglesRead: 2,
      created: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      failed: 0,
      errors: [],
    };

    const notes: MappedAnkiNote[] = [
      {
        keyTag: 'na_sync_key_a',
        pageTag: 'na_sync_page_x',
        hashTag: 'na_sync_hash_1',
        deckName: 'Deck Test',
        front: 'Q1',
        backHtml: '<div>A1</div>',
      },
      {
        keyTag: 'na_sync_key_b',
        pageTag: 'na_sync_page_x',
        hashTag: 'na_sync_hash_2',
        deckName: 'Deck Test',
        front: 'Q2',
        backHtml: '<div>A2</div>',
      },
    ];

    const result = await client.syncPage(pageStats, notes);

    expect(dedupSpy).toHaveBeenCalledWith(
      'page-abc',
      expect.stringMatching(/^na_sync_page_/),
    );
    expect(result.unchanged).toBe(2);
  });

  it('adopta nota existente cuando addNote falla por duplicado de Front', async () => {
    const client = createClient();

    jest
      .spyOn(client as never, 'deduplicatePageByKeyTag' as never)
      .mockResolvedValue({
        strategy: 'oldest-note-id',
        conflictsFound: 0,
        duplicatesRemoved: 0,
        removedNoteIds: [],
        conflicts: [],
      });

    jest
      .spyOn(client as never, 'syncDeletedNotes' as never)
      .mockResolvedValue({ deleted: 0, failed: 0, errors: [] });

    jest
      .spyOn(client as never, 'invoke' as never)
      .mockImplementation(
        async (action: string, params?: Record<string, unknown>) => {
          if (
            action === 'findNotes' &&
            params?.query === 'tag:na_sync_key_new'
          ) {
            return [];
          }

          if (action === 'createDeck') {
            return null;
          }

          if (action === 'addNote') {
            throw new Error(
              'AnkiConnect error en addNote: cannot create note because it is a duplicate',
            );
          }

          if (
            action === 'findNotes' &&
            typeof params?.query === 'string' &&
            params.query.includes('deck:"Deck Test"')
          ) {
            return [42];
          }

          if (action === 'notesInfo' && Array.isArray(params?.notes)) {
            if ((params.notes as number[])[0] === 42) {
              return [
                {
                  noteId: 42,
                  tags: ['legacy_tag'],
                  fields: {
                    Front: { value: 'Pregunta duplicada' },
                    Back: { value: 'Back legacy' },
                  },
                },
              ];
            }
            return [
              {
                noteId: 42,
                tags: ['legacy_tag'],
              },
            ];
          }

          if (action === 'updateNoteFields') {
            return null;
          }

          if (action === 'addTags') {
            return null;
          }

          if (action === 'findCards') {
            return [];
          }

          throw new Error(`Acción inesperada en test: ${action}`);
        },
      );

    const stats: PageSyncStats = {
      notionPageId: 'page-dup',
      deckName: 'Deck Test',
      togglesRead: 1,
      created: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      failed: 0,
      errors: [],
    };

    const notes: MappedAnkiNote[] = [
      {
        keyTag: 'na_sync_key_new',
        pageTag: 'na_sync_page_new',
        hashTag: 'na_sync_hash_new',
        deckName: 'Deck Test',
        front: 'Pregunta duplicada',
        backHtml: '<div>Back nuevo</div>',
      },
    ];

    const result = await client.syncPage(stats, notes);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('no actualiza cuando hashTag coincide aunque el html difiera por formato', async () => {
    const client = createClient();
    const updateSpy = jest.spyOn(client as never, 'updateNote' as never);

    const status = await (
      client as unknown as {
        syncExistingNote: (
          pageStats: { notionPageId: string },
          note: MappedAnkiNote,
          existing: {
            noteId: number;
            tags: string[];
            fields: {
              Front: { value: string };
              Back: { value: string };
            };
          },
        ) => Promise<'unchanged' | 'updated'>;
      }
    ).syncExistingNote(
      { notionPageId: 'page-hash' },
      {
        keyTag: 'na_sync_key_hash',
        pageTag: 'na_sync_page_hash',
        hashTag: 'na_sync_hash_same',
        deckName: 'Deck Test',
        front: 'Pregunta estable',
        backHtml: '<div>Back desde Notion</div>',
      },
      {
        noteId: 99,
        tags: ['na_sync_key_hash', 'na_sync_hash_same'],
        fields: {
          Front: { value: 'Pregunta estable' },
          Back: {
            value:
              '<div class="anki-generated"><span>Back desde Notion</span></div>',
          },
        },
      },
    );

    expect(status).toBe('unchanged');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('no actualiza cuando solo cambia filename embebido legacy vs nuevo', async () => {
    const client = createClient();
    const updateSpy = jest.spyOn(client as never, 'updateNote' as never);

    const status = await (
      client as unknown as {
        syncExistingNote: (
          pageStats: { notionPageId: string },
          note: MappedAnkiNote,
          existing: {
            noteId: number;
            tags: string[];
            fields: {
              Front: { value: string };
              Back: { value: string };
            };
          },
        ) => Promise<'unchanged' | 'updated'>;
      }
    ).syncExistingNote(
      { notionPageId: 'page-legacy' },
      {
        keyTag: 'na_sync_key_legacy',
        pageTag: 'na_sync_page_legacy',
        hashTag: 'na_sync_hash_new_format',
        deckName: 'Deck Test',
        front: 'Pregunta estable media',
        backHtml:
          '<div style="text-align: left;"><div><img src="na_sync_6c7a1f2e_1a2b3c4d_0.png" /></div></div>',
      },
      {
        noteId: 101,
        tags: ['na_sync_key_legacy', 'na_sync_hash_old_format'],
        fields: {
          Front: { value: 'Pregunta estable media' },
          Back: {
            value:
              '<div style="text-align: left;"><div><img src="na_sync_6c7a1f2e_1a2b3c4d_0_9f8e7d6c5b.png" /></div></div>',
          },
        },
      },
    );

    expect(status).toBe('unchanged');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('sube media embebida antes de crear la nota en Anki', async () => {
    const client = createClient();
    const actionOrder: string[] = [];

    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('img-bytes').buffer,
    } as unknown as Response);

    jest
      .spyOn(client as never, 'invoke' as never)
      .mockImplementation(
        async (action: string, params?: Record<string, unknown>) => {
          actionOrder.push(action);

          if (
            action === 'findNotes' &&
            params?.query === 'tag:na_sync_key_media'
          ) {
            return [];
          }

          if (action === 'createDeck') {
            return null;
          }

          if (action === 'storeMediaFile') {
            expect(params?.filename).toBe('media-test.png');
            expect(typeof params?.data).toBe('string');
            return null;
          }

          if (action === 'addNote') {
            return 123;
          }

          if (action === 'findNotes' && typeof params?.query === 'string') {
            return [];
          }

          if (action === 'notesInfo') {
            return [];
          }

          if (action === 'deleteNotes') {
            return null;
          }

          throw new Error(`Acción inesperada en test: ${action}`);
        },
      );

    const stats: PageSyncStats = {
      notionPageId: 'page-media',
      deckName: 'Deck Test',
      togglesRead: 1,
      created: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      failed: 0,
      errors: [],
    };

    const notes: MappedAnkiNote[] = [
      {
        keyTag: 'na_sync_key_media',
        pageTag: 'na_sync_page_media',
        hashTag: 'na_sync_hash_media',
        deckName: 'Deck Test',
        front: 'Pregunta media',
        backHtml: '<div><img src="media-test.png" /></div>',
        mediaFiles: [
          {
            filename: 'media-test.png',
            sourceUrl: 'https://example.com/media-test.png',
          },
        ],
      },
    ];

    const result = await client.syncPage(stats, notes);

    expect(result.created).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/media-test.png',
    );
    expect(actionOrder.indexOf('storeMediaFile')).toBeGreaterThan(-1);
    expect(actionOrder.indexOf('addNote')).toBeGreaterThan(-1);
    expect(actionOrder.indexOf('storeMediaFile')).toBeLessThan(
      actionOrder.indexOf('addNote'),
    );

    fetchMock.mockRestore();
  });
});
