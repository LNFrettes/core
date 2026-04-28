import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type {
  DeduplicationConflict,
  DeduplicationStats,
  MappedAnkiNote,
  PageSyncStats,
  ReformatPageStats,
} from './sync.types';

interface AnkiConnectResponse<T> {
  result: T;
  error: string | null;
}

interface AnkiNoteInfo {
  noteId: number;
  tags: string[];
  fields?: {
    Front?: { value?: string };
    Back?: { value?: string };
  };
}

interface DeckBinding {
  resolvedDeckName: string;
  resolvedDeckId: number;
}

interface NoteSyncOutcome {
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  errors: string[];
}

interface DeleteMissingOutcome {
  deleted: number;
  failed: number;
  errors: string[];
}

@Injectable()
export class AnkiConnectClient {
  private readonly logger = new Logger(AnkiConnectClient.name);
  private readonly endpoint: string;

  constructor(private readonly configService: ConfigService) {
    this.endpoint =
      this.configService.get<string>('ANKI_CONNECT_URL') ??
      'http://127.0.0.1:8765';
  }

  async syncPage(
    pageStats: PageSyncStats,
    notes: MappedAnkiNote[],
  ): Promise<PageSyncStats> {
    const targetKeyTags = new Set(notes.map((note) => note.keyTag));
    const pageTag = this.pageTagFromPageId(pageStats.notionPageId);
    await this.deduplicatePageByKeyTag(pageStats.notionPageId, pageTag);

    for (const note of notes) {
      const outcome = await this.syncSingleNote(pageStats, note);
      pageStats.created += outcome.created;
      pageStats.updated += outcome.updated;
      pageStats.unchanged += outcome.unchanged;
      pageStats.failed += outcome.failed;
      pageStats.errors.push(...outcome.errors);
    }

    const deletedOutcome = await this.syncDeletedNotes(
      pageStats.notionPageId,
      pageTag,
      targetKeyTags,
    );
    pageStats.deleted += deletedOutcome.deleted;
    pageStats.failed += deletedOutcome.failed;
    pageStats.errors.push(...deletedOutcome.errors);

    return pageStats;
  }

  async reformatPage(
    pageStats: ReformatPageStats,
    notes: MappedAnkiNote[],
  ): Promise<ReformatPageStats> {
    const total = notes.length;
    if (total === 0) {
      this.logger.log(
        `Reformat sin notas objetivo. page=${pageStats.notionPageId}, deck=${pageStats.deckName}`,
      );
      return pageStats;
    }

    this.logger.log(
      `Reformat en progreso: inicio page=${pageStats.notionPageId}, deck=${pageStats.deckName}, total=${total}`,
    );

    let processed = 0;
    for (const note of notes) {
      await this.reformatSingleNote(pageStats, note);
      processed += 1;
      this.logReformatProgress(pageStats, processed, total);
    }

    return pageStats;
  }

  private async reformatSingleNote(
    pageStats: ReformatPageStats,
    note: MappedAnkiNote,
  ): Promise<void> {
    try {
      const existing = await this.findByKeyTag(note.keyTag);
      if (existing == null) {
        pageStats.missing += 1;
        return;
      }

      const existingFront = this.getFieldValue(existing, 'Front');
      const existingBack = this.getFieldValue(existing, 'Back');
      const semanticExistingHash = this.computeSemanticHash(
        existingFront,
        existingBack,
      );
      const semanticNewHash = this.computeSemanticHash(
        note.front,
        note.backHtml,
      );

      if (semanticExistingHash === semanticNewHash) {
        pageStats.unchanged += 1;
        return;
      }

      const existingHash = this.findHashTag(existing.tags);
      await this.updateNote(
        existing.noteId,
        note,
        {
          notionPageId: pageStats.notionPageId,
          oldHash: existingHash,
          noteId: existing.noteId,
        },
        false,
      );
      pageStats.reformatted += 1;
    } catch (error) {
      pageStats.failed += 1;
      const message =
        error instanceof Error
          ? error.message
          : 'Error desconocido reformateando nota en Anki';
      pageStats.errors.push(message);

      if (error instanceof Error) {
        this.logger.error(
          `Error reformat Anki página=${pageStats.notionPageId}, deck=${pageStats.deckName}, key=${note.keyTag}: ${error.message}`,
          error.stack,
        );
      } else {
        this.logger.error(
          `Error reformat Anki página=${pageStats.notionPageId}, deck=${pageStats.deckName}, key=${note.keyTag}: ${message}`,
        );
      }
    }
  }

  private logReformatProgress(
    pageStats: ReformatPageStats,
    processed: number,
    total: number,
  ): void {
    if (processed % 50 !== 0 && processed !== total) {
      return;
    }

    const percent = Math.round((processed * 100) / total);
    this.logger.log(
      `Reformat en progreso: page=${pageStats.notionPageId}, deck=${pageStats.deckName}, processed=${processed}/${total} (${percent}%), reformatted=${pageStats.reformatted}, unchanged=${pageStats.unchanged}, missing=${pageStats.missing}, failed=${pageStats.failed}`,
    );
  }

  private async syncSingleNote(
    pageStats: Pick<PageSyncStats, 'notionPageId'>,
    note: MappedAnkiNote,
  ): Promise<NoteSyncOutcome> {
    try {
      const existing = await this.findByKeyTag(note.keyTag);

      if (existing == null) {
        const creation = await this.createOrAdoptNote(note, {
          notionPageId: pageStats.notionPageId,
        });

        if (creation === 'adopted') {
          return {
            created: 0,
            updated: 1,
            unchanged: 0,
            failed: 0,
            errors: [],
          };
        }

        return {
          created: 1,
          updated: 0,
          unchanged: 0,
          failed: 0,
          errors: [],
        };
      }

      const status = await this.syncExistingNote(pageStats, note, existing);
      if (status === 'unchanged') {
        return {
          created: 0,
          updated: 0,
          unchanged: 1,
          failed: 0,
          errors: [],
        };
      }

      return {
        created: 0,
        updated: 1,
        unchanged: 0,
        failed: 0,
        errors: [],
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Error desconocido sincronizando Anki';

      if (error instanceof Error) {
        this.logger.error(
          `Error Anki nota key=${note.keyTag}, page=${pageStats.notionPageId}, deck=${note.deckName}: ${error.message}`,
          error.stack,
        );
      } else {
        this.logger.error(
          `Error Anki nota key=${note.keyTag}, page=${pageStats.notionPageId}, deck=${note.deckName}: ${message}`,
        );
      }

      return {
        created: 0,
        updated: 0,
        unchanged: 0,
        failed: 1,
        errors: [message],
      };
    }
  }

  private async syncDeletedNotes(
    notionPageId: string,
    pageTag: string,
    targetKeyTags: Set<string>,
  ): Promise<DeleteMissingOutcome> {
    try {
      const deleted = await this.deleteMissingNotes(pageTag, targetKeyTags);
      return {
        deleted,
        failed: 0,
        errors: [],
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Error desconocido eliminando notas huérfanas en Anki';

      if (error instanceof Error) {
        this.logger.error(
          `Error borrando notas huérfanas page=${notionPageId}: ${error.message}`,
          error.stack,
        );
      } else {
        this.logger.error(
          `Error borrando notas huérfanas page=${notionPageId}: ${message}`,
        );
      }

      return {
        deleted: 0,
        failed: 1,
        errors: [message],
      };
    }
  }

  private async syncExistingNote(
    pageStats: Pick<PageSyncStats, 'notionPageId'>,
    note: MappedAnkiNote,
    existing: AnkiNoteInfo,
  ): Promise<'unchanged' | 'updated'> {
    const existingHash = this.findHashTag(existing.tags);

    // Si el hash de sincronización coincide, no hay cambio funcional en Notion
    // aunque Anki haya reformateado el HTML internamente.
    if (existingHash === note.hashTag) {
      return 'unchanged';
    }

    const existingFront = this.getFieldValue(existing, 'Front');
    const existingBack = this.getFieldValue(existing, 'Back');
    const semanticExistingHash = this.computeSemanticHash(
      existingFront,
      existingBack,
    );
    const semanticNewHash = this.computeSemanticHash(note.front, note.backHtml);

    if (semanticExistingHash === semanticNewHash) {
      if (existingHash !== note.hashTag) {
        this.logger.log(
          `Hash tag mismatch ignorado por equivalencia semántica. page=${pageStats.notionPageId}, key=${note.keyTag}, noteId=${existing.noteId}, oldHash=${existingHash ?? 'missing'}, newHash=${note.hashTag}, semanticSha8=${semanticNewHash.slice(0, 8)}`,
        );
      }
      return 'unchanged';
    }

    const previousFingerprint = this.buildContentFingerprint(
      existingFront,
      existingBack,
    );
    const nextFingerprint = this.buildContentFingerprint(
      note.front,
      note.backHtml,
    );

    this.logger.warn(
      `Hash mismatch detectado. page=${pageStats.notionPageId}, deck=${note.deckName}, key=${note.keyTag}, noteId=${existing.noteId}, oldHash=${existingHash ?? 'missing'}, newHash=${note.hashTag}, oldFrontLen=${previousFingerprint.frontLength}, newFrontLen=${nextFingerprint.frontLength}, oldBackLen=${previousFingerprint.backHtmlLength}, newBackLen=${nextFingerprint.backHtmlLength}, oldBackSha8=${previousFingerprint.backHtmlSha1Short}, newBackSha8=${nextFingerprint.backHtmlSha1Short}, oldImgCount=${previousFingerprint.imageCount}, newImgCount=${nextFingerprint.imageCount}, oldSemanticSha8=${semanticExistingHash.slice(0, 8)}, newSemanticSha8=${semanticNewHash.slice(0, 8)}, mapTitleLen=${note.diagnostics?.titleLength ?? -1}, mapBackLen=${note.diagnostics?.backHtmlLength ?? -1}, mapBackSha8=${note.diagnostics?.backHtmlHashShort ?? 'n/a'}, mapImgCount=${note.diagnostics?.imageCount ?? -1}, mapHasBodyHtml=${note.diagnostics?.hasBodyHtml ?? false}, mapHasBodyText=${note.diagnostics?.hasBodyText ?? false}`,
    );

    await this.updateNote(existing.noteId, note, {
      notionPageId: pageStats.notionPageId,
      oldHash: existingHash,
      noteId: existing.noteId,
    });

    return 'updated';
  }

  async healthcheck(): Promise<boolean> {
    try {
      await this.invoke<number>('version');
      return true;
    } catch {
      return false;
    }
  }

  async resolveDeckBinding(
    preferredDeckName: string,
    knownDeckId: number | null,
  ): Promise<DeckBinding> {
    const decks = await this.getDeckNamesAndIds();

    if (knownDeckId != null) {
      const byId = Object.entries(decks).find(
        ([, deckId]) => deckId === knownDeckId,
      );
      if (byId != null) {
        return {
          resolvedDeckName: byId[0],
          resolvedDeckId: byId[1],
        };
      }
    }

    const byName = decks[preferredDeckName];
    if (byName != null) {
      return {
        resolvedDeckName: preferredDeckName,
        resolvedDeckId: byName,
      };
    }

    await this.ensureDeck(preferredDeckName);

    const refreshed = await this.getDeckNamesAndIds();
    const createdDeckId = refreshed[preferredDeckName];
    if (createdDeckId == null) {
      throw new Error(
        `No se pudo resolver el mazo '${preferredDeckName}' luego de intentar crearlo en Anki.`,
      );
    }

    return {
      resolvedDeckName: preferredDeckName,
      resolvedDeckId: createdDeckId,
    };
  }

  private async createOrAdoptNote(
    note: MappedAnkiNote,
    context: { notionPageId: string },
  ): Promise<'created' | 'adopted'> {
    await this.ensureDeck(note.deckName);
    await this.uploadMediaFiles(note, context);

    try {
      await this.invoke<number>('addNote', {
        note: {
          deckName: note.deckName,
          modelName: 'Basic',
          fields: {
            Front: note.front,
            Back: note.backHtml,
          },
          tags: [note.keyTag, note.pageTag, note.hashTag],
        },
      });
      return 'created';
    } catch (error) {
      if (!this.isAnkiDuplicateAddError(error)) {
        throw error;
      }

      const adopted = await this.tryAdoptExistingDuplicate(note, context);
      if (adopted) {
        return 'adopted';
      }

      throw error;
    }
  }

  private isAnkiDuplicateAddError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return error.message.includes(
      'cannot create note because it is a duplicate',
    );
  }

  private async tryAdoptExistingDuplicate(
    note: MappedAnkiNote,
    context: { notionPageId: string },
  ): Promise<boolean> {
    const duplicateQuery = `deck:"${this.escapeForAnkiQuery(note.deckName)}" note:"Basic" "${this.escapeForAnkiQuery(note.front)}"`;
    const candidateIds = await this.invoke<number[]>('findNotes', {
      query: duplicateQuery,
    });

    if (candidateIds.length === 0) {
      return false;
    }

    const candidates = await this.invoke<AnkiNoteInfo[]>('notesInfo', {
      notes: candidateIds,
    });

    const normalizedTargetFront = this.normalizeTextForHash(note.front);
    const eligible = candidates.filter((candidate) => {
      const candidateFront = this.normalizeTextForHash(
        this.getFieldValue(candidate, 'Front'),
      );
      if (candidateFront !== normalizedTargetFront) {
        return false;
      }

      const candidateKeyTag = this.findKeyTag(candidate.tags);
      if (candidateKeyTag != null && candidateKeyTag !== note.keyTag) {
        return false;
      }

      const candidatePageTag = this.findPageTag(candidate.tags);
      if (candidatePageTag != null && candidatePageTag !== note.pageTag) {
        return false;
      }

      return true;
    });

    if (eligible.length === 0) {
      return false;
    }

    const selected = [...eligible].sort((a, b) => a.noteId - b.noteId)[0];
    const previousHash = this.findHashTag(selected.tags);

    this.logger.warn(
      `Adopción de duplicado por Front. page=${context.notionPageId}, key=${note.keyTag}, deck=${note.deckName}, adoptedNoteId=${selected.noteId}`,
    );

    await this.updateNote(
      selected.noteId,
      note,
      {
        notionPageId: context.notionPageId,
        oldHash: previousHash,
        noteId: selected.noteId,
      },
      false,
    );

    return true;
  }

  private escapeForAnkiQuery(value: string): string {
    return value
      .replaceAll('\\', String.raw`\\`)
      .replaceAll('"', String.raw`\"`);
  }

  private async updateNote(
    noteId: number,
    note: MappedAnkiNote,
    context: {
      notionPageId: string;
      oldHash: string | null;
      noteId: number;
    },
    shouldForgetCards = true,
  ): Promise<void> {
    this.logger.log(
      `Actualizando nota por hash mismatch. page=${context.notionPageId}, key=${note.keyTag}, noteId=${context.noteId}, oldHash=${context.oldHash ?? 'missing'}, newHash=${note.hashTag}`,
    );

    await this.uploadMediaFiles(note, { notionPageId: context.notionPageId });

    await this.invoke<unknown>('updateNoteFields', {
      note: {
        id: noteId,
        fields: {
          Front: note.front,
          Back: note.backHtml,
        },
      },
    });

    const oldTags = await this.getTagsToReplace(noteId);
    if (oldTags.length > 0) {
      this.logger.log(
        `Reemplazando tags de sincronización. noteId=${noteId}, key=${note.keyTag}, tagsToReplace=${oldTags.length}`,
      );
      await this.invoke<unknown>('removeTags', {
        notes: [noteId],
        tags: oldTags.join(' '),
      });
    }

    await this.invoke<unknown>('addTags', {
      notes: [noteId],
      tags: [note.keyTag, note.pageTag, note.hashTag].join(' '),
    });

    if (shouldForgetCards) {
      await this.forgetCardsForNote(noteId, {
        notionPageId: context.notionPageId,
        keyTag: note.keyTag,
        oldHash: context.oldHash,
        newHash: note.hashTag,
      });
      return;
    }

    this.logger.log(
      `Nota reformateada sin reset de cards. page=${context.notionPageId}, noteId=${noteId}, key=${note.keyTag}, oldHash=${context.oldHash ?? 'missing'}, newHash=${note.hashTag}`,
    );
  }

  private async forgetCardsForNote(
    noteId: number,
    context: {
      notionPageId: string;
      keyTag: string;
      oldHash: string | null;
      newHash: string;
    },
  ): Promise<void> {
    const cardIds = await this.invoke<number[]>('findCards', {
      query: `nid:${noteId}`,
    });

    if (cardIds.length === 0) {
      return;
    }

    await this.invoke<unknown>('forgetCards', { cards: cardIds });
    this.logger.warn(
      `Reset de cards ejecutado por update. page=${context.notionPageId}, noteId=${noteId}, key=${context.keyTag}, cardsReset=${cardIds.length}, oldHash=${context.oldHash ?? 'missing'}, newHash=${context.newHash}`,
    );
  }

  private async deleteMissingNotes(
    pageTag: string,
    targetKeyTags: Set<string>,
  ): Promise<number> {
    const noteIds = await this.invoke<number[]>('findNotes', {
      query: `tag:${pageTag}`,
    });
    if (noteIds.length === 0) {
      return 0;
    }

    const infos = await this.invoke<AnkiNoteInfo[]>('notesInfo', {
      notes: noteIds,
    });

    const toDelete = infos
      .filter((info) => {
        const keyTag = info.tags.find((tag) => tag.startsWith('na_sync_key_'));
        return keyTag != null && !targetKeyTags.has(keyTag);
      })
      .map((info) => info.noteId);

    if (toDelete.length === 0) {
      return 0;
    }

    this.logger.log(
      `Página tag=${pageTag}: eliminando ${toDelete.length} notas huérfanas (toggle vacío o removido en Notion).`,
    );

    await this.invoke<unknown>('deleteNotes', { notes: toDelete });
    return toDelete.length;
  }

  private async findByKeyTag(keyTag: string): Promise<AnkiNoteInfo | null> {
    const noteIds = await this.invoke<number[]>('findNotes', {
      query: `tag:${keyTag}`,
    });
    if (noteIds.length === 0) {
      return null;
    }

    if (noteIds.length > 1) {
      const [keptNoteId, ...removedNoteIds] = [...noteIds].sort(
        (a, b) => a - b,
      );

      this.logger.warn(
        `Detectados duplicados por keyTag=${keyTag}. conservada=${keptNoteId}, removidas=${removedNoteIds.join(',')}`,
      );

      await this.invoke<unknown>('deleteNotes', { notes: removedNoteIds });
      return this.getSingleNoteInfo(keptNoteId);
    }

    return this.getSingleNoteInfo(noteIds[0]);
  }

  private async deduplicatePageByKeyTag(
    notionPageId: string,
    pageTag: string,
  ): Promise<DeduplicationStats> {
    const noteIds = await this.invoke<number[]>('findNotes', {
      query: `tag:${pageTag}`,
    });

    if (noteIds.length < 2) {
      return {
        strategy: 'oldest-note-id',
        conflictsFound: 0,
        duplicatesRemoved: 0,
        removedNoteIds: [],
        conflicts: [],
      };
    }

    const infos = await this.invoke<AnkiNoteInfo[]>('notesInfo', {
      notes: noteIds,
    });

    const groupedByKeyTag = new Map<string, number[]>();
    for (const info of infos) {
      const keyTag = info.tags.find((tag) => tag.startsWith('na_sync_key_'));
      if (keyTag == null) {
        continue;
      }

      const current = groupedByKeyTag.get(keyTag) ?? [];
      current.push(info.noteId);
      groupedByKeyTag.set(keyTag, current);
    }

    const conflicts: DeduplicationConflict[] = [];
    const removedNoteIds: number[] = [];
    for (const [keyTag, ids] of groupedByKeyTag.entries()) {
      if (ids.length < 2) {
        continue;
      }

      const sorted = [...ids].sort((a, b) => a - b);
      const [keptNoteId, ...duplicates] = sorted;

      conflicts.push({
        keyTag,
        keptNoteId,
        removedNoteIds: duplicates,
      });
      removedNoteIds.push(...duplicates);
    }

    if (removedNoteIds.length > 0) {
      await this.invoke<unknown>('deleteNotes', { notes: removedNoteIds });
      this.logger.warn(
        `Deduplicación aplicada. page=${notionPageId}, conflicts=${conflicts.length}, removed=${removedNoteIds.length}`,
      );
    }

    return {
      strategy: 'oldest-note-id',
      conflictsFound: conflicts.length,
      duplicatesRemoved: removedNoteIds.length,
      removedNoteIds,
      conflicts,
    };
  }

  private async getSingleNoteInfo(
    noteId: number,
  ): Promise<AnkiNoteInfo | null> {
    const infos = await this.invoke<AnkiNoteInfo[]>('notesInfo', {
      notes: [noteId],
    });
    return infos[0] ?? null;
  }

  private findHashTag(tags: string[]): string | null {
    return tags.find((tag) => tag.startsWith('na_sync_hash_')) ?? null;
  }

  private findKeyTag(tags: string[]): string | null {
    return tags.find((tag) => tag.startsWith('na_sync_key_')) ?? null;
  }

  private findPageTag(tags: string[]): string | null {
    return tags.find((tag) => tag.startsWith('na_sync_page_')) ?? null;
  }

  private async getTagsToReplace(noteId: number): Promise<string[]> {
    const infos = await this.invoke<AnkiNoteInfo[]>('notesInfo', {
      notes: [noteId],
    });
    const tags = infos[0]?.tags ?? [];
    return tags.filter(
      (tag) =>
        tag.startsWith('na_sync_hash_') ||
        tag.startsWith('na_sync_page_') ||
        tag.startsWith('na_sync_key_'),
    );
  }

  private getFieldValue(info: AnkiNoteInfo, field: 'Front' | 'Back'): string {
    const value = info.fields?.[field]?.value;
    return typeof value === 'string' ? value : '';
  }

  private buildContentFingerprint(
    front: string,
    backHtml: string,
  ): {
    frontLength: number;
    backHtmlLength: number;
    backHtmlSha1Short: string;
    imageCount: number;
  } {
    const imageCount = Array.from(
      backHtml.matchAll(/<img\s+[^>]*src=/gi),
    ).length;
    return {
      frontLength: front.length,
      backHtmlLength: backHtml.length,
      backHtmlSha1Short: this.sha1(backHtml).slice(0, 8),
      imageCount,
    };
  }

  private computeSemanticHash(front: string, backHtml: string): string {
    const normalizedFront = this.normalizeTextForHash(front);
    const normalizedBack = this.normalizeBackHtmlForHash(backHtml);
    return this.sha1(`${normalizedFront}\n${normalizedBack}`);
  }

  private normalizeTextForHash(value: string): string {
    return value.replaceAll(/\s+/g, ' ').trim();
  }

  private normalizeBackHtmlForHash(html: string): string {
    const normalizedImageUrls = this.normalizeImageUrlsInHtmlForHash(html);
    return normalizedImageUrls
      .replaceAll(/\s+/g, ' ')
      .replaceAll(/>\s+</g, '><')
      .trim();
  }

  private normalizeImageUrlsInHtmlForHash(html: string): string {
    return html.replaceAll(
      /(<img\s+[^>]*src=")(.*?)("[^>]*>)/gi,
      (_full, prefix: string, src: string, suffix: string) => {
        const normalizedSrc = this.normalizeImageUrlForHash(src);
        return `${prefix}${normalizedSrc}${suffix}`;
      },
    );
  }

  private normalizeImageUrlForHash(value: string): string {
    try {
      const parsed = new URL(value);
      parsed.search = '';
      parsed.hash = '';
      parsed.pathname = this.normalizeEmbeddedMediaFilenameForHash(
        parsed.pathname,
      );
      return parsed.toString();
    } catch {
      return this.normalizeEmbeddedMediaFilenameForHash(value);
    }
  }

  private normalizeEmbeddedMediaFilenameForHash(value: string): string {
    const filePattern =
      /^na_sync_([0-9a-f]{8})_([0-9a-f]{8})_(\d+)(?:_[0-9a-f]{10})?\.(jpg|png|gif|webp|svg)$/i;

    const lastSlash = value.lastIndexOf('/');
    const prefix = lastSlash >= 0 ? value.slice(0, lastSlash + 1) : '';
    const filename = lastSlash >= 0 ? value.slice(lastSlash + 1) : value;

    const match = filePattern.exec(filename);
    if (match == null) {
      return value;
    }

    const canonicalFilename = `na_sync_${match[1]}_${match[2]}_${match[3]}.${match[4].toLowerCase()}`;
    return `${prefix}${canonicalFilename}`;
  }

  private sha1(value: string): string {
    return createHash('sha1').update(value).digest('hex');
  }

  private async ensureDeck(deckName: string): Promise<void> {
    await this.invoke<unknown>('createDeck', { deck: deckName });
  }

  private async uploadMediaFiles(
    note: MappedAnkiNote,
    context: { notionPageId: string },
  ): Promise<void> {
    const mediaFiles = note.mediaFiles ?? [];
    if (mediaFiles.length === 0) {
      return;
    }

    for (const mediaFile of mediaFiles) {
      const response = await fetch(mediaFile.sourceUrl);
      if (!response.ok) {
        throw new Error(
          `No se pudo descargar imagen para embedding. page=${context.notionPageId}, key=${note.keyTag}, status=${response.status}, url=${mediaFile.sourceUrl}`,
        );
      }

      const bytes = await response.arrayBuffer();
      const data = Buffer.from(bytes).toString('base64');

      await this.invoke<unknown>('storeMediaFile', {
        filename: mediaFile.filename,
        data,
      });
    }
  }

  private async getDeckNamesAndIds(): Promise<Record<string, number>> {
    return this.invoke<Record<string, number>>('deckNamesAndIds');
  }

  private pageTagFromPageId(pageId: string): string {
    const pageHash = createHash('sha1')
      .update(pageId)
      .digest('hex')
      .slice(0, 16);
    return `na_sync_page_${pageHash}`;
  }

  private async invoke<T>(
    action: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action,
        version: 6,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `AnkiConnect devolvió HTTP ${response.status} en acción ${action}`,
      );
    }

    const payload = (await response.json()) as AnkiConnectResponse<T>;
    if (payload.error != null) {
      throw new Error(`AnkiConnect error en ${action}: ${payload.error}`);
    }

    return payload.result;
  }
}
