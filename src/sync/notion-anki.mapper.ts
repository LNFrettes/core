import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  MappedAnkiNote,
  NoteMediaFile,
  NotionToggle,
  SyncPageRecord,
} from './sync.types';

@Injectable()
export class NotionAnkiMapper {
  mapToggle(page: SyncPageRecord, toggle: NotionToggle): MappedAnkiNote {
    const key = `${page.notionPageId}:${toggle.id}`;
    const keyHash = this.sha1(key).slice(0, 16);
    const pageHash = this.sha1(page.notionPageId).slice(0, 16);
    const mediaFiles = this.buildMediaFiles(page.notionPageId, toggle);

    const backHtml = this.buildBackHtml(toggle, mediaFiles);
    const normalizedTitle = this.normalizeTextForHash(toggle.title);
    const normalizedBackHtml = this.normalizeBackHtmlForHash(backHtml);
    const contentHash = this.sha1(
      `${normalizedTitle}\n${normalizedBackHtml}`,
    ).slice(0, 16);
    const backHtmlHashShort = this.sha1(backHtml).slice(0, 8);

    return {
      keyTag: `na_sync_key_${keyHash}`,
      pageTag: `na_sync_page_${pageHash}`,
      hashTag: `na_sync_hash_${contentHash}`,
      deckName: page.deckName,
      front: toggle.title,
      backHtml,
      mediaFiles,
      diagnostics: {
        titleLength: toggle.title.length,
        backHtmlLength: backHtml.length,
        backHtmlHashShort,
        imageCount: toggle.imageUrls.length,
        hasBodyHtml: toggle.bodyHtml.trim().length > 0,
        hasBodyText: toggle.bodyText.trim().length > 0,
      },
    };
  }

  private buildBackHtml(
    toggle: NotionToggle,
    mediaFiles: NoteMediaFile[],
  ): string {
    let imageIndex = 0;
    const embeddedBodyHtml = toggle.bodyHtml.replaceAll(
      /(<img\s+[^>]*src=")(.*?)("[^>]*>)/gi,
      (_full, prefix: string, _src: string, suffix: string) => {
        const media = mediaFiles[imageIndex];
        imageIndex += 1;
        if (media == null) {
          return '';
        }

        return `${prefix}${this.escapeAttribute(media.filename)}${suffix}`;
      },
    );

    const formattedBody = toggle.bodyHtml.trim();

    const escapedLines =
      formattedBody.length > 0
        ? [embeddedBodyHtml]
        : toggle.bodyText
            .split('\n')
            .map((line) => this.escapeHtml(line.trim()))
            .filter((line) => line.length > 0)
            .map((line) => `<div>${line}</div>`);

    const remainingMediaFiles = mediaFiles.slice(imageIndex);
    const imageLines =
      formattedBody.length > 0
        ? remainingMediaFiles.map(
            (mediaFile) =>
              `<div><img src="${this.escapeAttribute(mediaFile.filename)}" /></div>`,
          )
        : mediaFiles.map(
            (mediaFile) =>
              `<div><img src="${this.escapeAttribute(mediaFile.filename)}" /></div>`,
          );

    const content = [...escapedLines, ...imageLines].join('');
    if (content.length === 0) {
      return content;
    }

    return `<div style="text-align: left;">${content}</div>`;
  }

  private buildMediaFiles(
    notionPageId: string,
    toggle: Pick<NotionToggle, 'id' | 'imageUrls'>,
  ): NoteMediaFile[] {
    return toggle.imageUrls.map((imageUrl, index) => {
      const extension = this.resolveImageExtension(imageUrl);
      const pageHash = this.sha1(notionPageId).slice(0, 8);
      const toggleHash = this.sha1(toggle.id).slice(0, 8);

      return {
        filename: `na_sync_${pageHash}_${toggleHash}_${index}.${extension}`,
        sourceUrl: imageUrl,
      };
    });
  }

  private resolveImageExtension(value: string): string {
    const extensionRegex = /\.([a-zA-Z0-9]+)$/;

    try {
      const parsed = new URL(value);
      const match = extensionRegex.exec(parsed.pathname);
      if (match == null) {
        return 'png';
      }

      const extension = match[1].toLowerCase();
      if (extension === 'jpeg') {
        return 'jpg';
      }

      if (['jpg', 'png', 'gif', 'webp', 'svg'].includes(extension)) {
        return extension;
      }

      return 'png';
    } catch {
      return 'png';
    }
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  private escapeAttribute(value: string): string {
    return this.escapeHtml(value);
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
      return parsed.toString();
    } catch {
      return value;
    }
  }

  private sha1(value: string): string {
    return createHash('sha1').update(value).digest('hex');
  }
}
