import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  MappedAnkiNote,
  NotionToggle,
  SyncPageRecord,
} from './sync.types';

@Injectable()
export class NotionAnkiMapper {
  mapToggle(page: SyncPageRecord, toggle: NotionToggle): MappedAnkiNote {
    const key = `${page.notionPageId}:${toggle.id}`;
    const keyHash = this.sha1(key).slice(0, 16);
    const pageHash = this.sha1(page.notionPageId).slice(0, 16);

    const backHtml = this.buildBackHtml(toggle);
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

  private buildBackHtml(toggle: NotionToggle): string {
    const formattedBody = toggle.bodyHtml.trim();

    const escapedLines =
      formattedBody.length > 0
        ? [formattedBody]
        : toggle.bodyText
            .split('\n')
            .map((line) => this.escapeHtml(line.trim()))
            .filter((line) => line.length > 0)
            .map((line) => `<div>${line}</div>`);

    const imageLines = toggle.imageUrls.map(
      (imageUrl) =>
        `<div><img src="${this.escapeAttribute(imageUrl)}" /></div>`,
    );

    const content = [...escapedLines, ...imageLines].join('');
    if (content.length === 0) {
      return content;
    }

    return `<div style="text-align: left;">${content}</div>`;
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
