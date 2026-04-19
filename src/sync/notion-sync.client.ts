import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@notionhq/client';
import type {
  BlockObjectResponse,
  ListBlockChildrenResponse,
  RichTextItemResponse,
} from '@notionhq/client/build/src/api-endpoints';
import type { NotionToggle } from './sync.types';

interface BlockWithDepth {
  block: BlockObjectResponse;
  depth: number;
}

interface BlockWithParent {
  block: BlockObjectResponse;
  parentId: string | null;
}

@Injectable()
export class NotionSyncClient {
  private readonly logger = new Logger(NotionSyncClient.name);
  private readonly client: Client;

  constructor(private readonly configService: ConfigService) {
    const notionToken = this.configService.getOrThrow<string>('NOTION_TOKEN');
    this.client = new Client({ auth: notionToken });
  }

  async getPageToggles(pageId: string): Promise<NotionToggle[]> {
    this.logger.log(`Notion getPageToggles: inicio page=${pageId}`);

    const blocks = await this.listChildrenRecursiveWithParent(pageId);
    this.logger.log(
      `Notion getPageToggles: bloques cargados page=${pageId}, totalBlocks=${blocks.length}`,
    );

    const blockById = new Map<string, BlockWithParent>();
    for (const entry of blocks) {
      blockById.set(entry.block.id, entry);
    }

    const toggles = blocks
      .filter(
        (
          entry,
        ): entry is BlockWithParent & {
          block: BlockObjectResponse & { type: 'toggle' };
        } => entry.block.type === 'toggle',
      )
      .filter((entry) => this.shouldCreateCardFromToggle(entry, blockById))
      .map((entry) => entry.block);

    this.logger.log(
      `Notion getPageToggles: toggles candidatos page=${pageId}, total=${toggles.length}`,
    );

    const normalized: NotionToggle[] = [];
    let processedToggles = 0;
    for (const toggle of toggles) {
      processedToggles += 1;
      if (processedToggles % 25 === 0 || processedToggles === toggles.length) {
        this.logger.log(
          `Notion getPageToggles: progreso page=${pageId}, toggles=${processedToggles}/${toggles.length}`,
        );
      }

      const childrenWithDepth = toggle.has_children
        ? await this.listChildrenRecursiveWithDepth(toggle.id)
        : [];

      const normalizedToggle: NotionToggle = {
        id: toggle.id,
        title: this.getToggleTitle(toggle),
        bodyText: this.collectPlainText(childrenWithDepth),
        bodyHtml: this.renderBlocksAsHtml(childrenWithDepth),
        imageUrls: this.collectImageUrls(childrenWithDepth),
      };

      if (this.isEmptyToggle(normalizedToggle)) {
        continue;
      }

      normalized.push(normalizedToggle);
    }

    this.logger.log(
      `Notion getPageToggles: fin page=${pageId}, togglesNormalizados=${normalized.length}`,
    );

    return normalized;
  }

  private async listChildrenRecursiveWithDepth(
    blockId: string,
    depth = 0,
  ): Promise<BlockWithDepth[]> {
    const result: BlockWithDepth[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let page = 0;

    do {
      page += 1;
      const response: ListBlockChildrenResponse =
        await this.client.blocks.children.list({
          block_id: blockId,
          start_cursor: cursor,
          page_size: 100,
        });

      const objects = response.results.filter(
        (item): item is BlockObjectResponse => item.object === 'block',
      );

      if (page > 1 || response.has_more) {
        this.logger.log(
          `Notion children(depth): block=${blockId}, depth=${depth}, page=${page}, batch=${objects.length}, acumulado=${result.length + objects.length}, hasMore=${response.has_more}`,
        );
      }

      for (const block of objects) {
        result.push({ block, depth });

        if (!block.has_children) {
          continue;
        }

        const descendants = await this.listChildrenRecursiveWithDepth(
          block.id,
          depth + 1,
        );
        result.push(...descendants);
      }

      cursor = this.resolveNextCursor(
        response,
        seenCursors,
        `Notion children(depth): block=${blockId}, depth=${depth}, page=${page}`,
      );
    } while (cursor != null);

    return result;
  }

  private async listChildrenRecursiveWithParent(
    blockId: string,
    parentId: string | null = null,
  ): Promise<BlockWithParent[]> {
    const result: BlockWithParent[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let page = 0;

    do {
      page += 1;
      const response: ListBlockChildrenResponse =
        await this.client.blocks.children.list({
          block_id: blockId,
          start_cursor: cursor,
          page_size: 100,
        });

      const objects = response.results.filter(
        (item): item is BlockObjectResponse => item.object === 'block',
      );

      if (page > 1 || response.has_more) {
        this.logger.log(
          `Notion children(parent): block=${blockId}, parent=${parentId ?? 'none'}, page=${page}, batch=${objects.length}, acumulado=${result.length + objects.length}, hasMore=${response.has_more}`,
        );
      }

      for (const block of objects) {
        result.push({ block, parentId });
      }

      for (const block of objects) {
        if (!block.has_children) {
          continue;
        }

        const descendants = await this.listChildrenRecursiveWithParent(
          block.id,
          block.id,
        );
        result.push(...descendants);
      }

      cursor = this.resolveNextCursor(
        response,
        seenCursors,
        `Notion children(parent): block=${blockId}, parent=${parentId ?? 'none'}, page=${page}`,
      );
    } while (cursor != null);

    return result;
  }

  private resolveNextCursor(
    response: ListBlockChildrenResponse,
    seenCursors: Set<string>,
    logContext: string,
  ): string | undefined {
    if (!response.has_more) {
      return undefined;
    }

    const nextCursor = response.next_cursor ?? undefined;
    if (nextCursor == null) {
      this.logger.warn(
        `${logContext}: has_more=true sin next_cursor. Se corta para evitar bucle.`,
      );
      return undefined;
    }

    if (seenCursors.has(nextCursor)) {
      this.logger.warn(
        `${logContext}: next_cursor repetido (${nextCursor}). Se corta para evitar bucle.`,
      );
      return undefined;
    }

    seenCursors.add(nextCursor);
    return nextCursor;
  }

  private shouldCreateCardFromToggle(
    toggleEntry: BlockWithParent,
    blockById: Map<string, BlockWithParent>,
  ): boolean {
    const toggleTitle = this.getToggleTitle(toggleEntry.block);
    if (this.isH4ContainerToggle(toggleTitle)) {
      return false;
    }

    const h4AncestorDistance = this.getDistanceToH4ContainerAncestor(
      toggleEntry,
      blockById,
    );

    if (h4AncestorDistance == null) {
      return true;
    }

    return h4AncestorDistance === 1;
  }

  private getDistanceToH4ContainerAncestor(
    entry: BlockWithParent,
    blockById: Map<string, BlockWithParent>,
  ): number | null {
    let distance = 0;
    let currentParentId = entry.parentId;

    while (currentParentId != null) {
      distance += 1;
      const parent = blockById.get(currentParentId);
      if (parent == null) {
        break;
      }

      if (
        parent.block.type === 'toggle' &&
        this.isH4ContainerToggle(this.getToggleTitle(parent.block))
      ) {
        return distance;
      }

      currentParentId = parent.parentId;
    }

    return null;
  }

  private isH4ContainerToggle(title: string): boolean {
    return /^h4-1\b/i.test(title.trim());
  }

  private collectPlainText(blocks: BlockWithDepth[]): string {
    const lines: string[] = [];

    for (const { block } of blocks) {
      const richText = this.extractPlainText(block);
      if (richText.trim().length > 0) {
        lines.push(richText);
      }
    }

    return lines.join('\n');
  }

  private collectImageUrls(blocks: BlockWithDepth[]): string[] {
    const urls = new Set<string>();

    for (const { block } of blocks) {
      if (block.type !== 'image') {
        continue;
      }

      const image = block.image;
      if (image.type === 'external') {
        urls.add(image.external.url);
      } else {
        urls.add(image.file.url);
      }
    }

    return Array.from(urls);
  }

  private renderBlocksAsHtml(blocks: BlockWithDepth[]): string {
    const htmlLines: string[] = [];
    const numberedCounters = new Map<number, number>();

    for (const { block, depth } of blocks) {
      const marginLeft = depth * 20;

      if (block.type === 'image') {
        const imageUrl =
          block.image.type === 'external'
            ? block.image.external.url
            : block.image.file.url;

        htmlLines.push(
          `<div style="margin-left:${marginLeft}px;"><img src="${this.escapeHtml(imageUrl)}" /></div>`,
        );
        continue;
      }

      const richText = this.extractRichText(block);
      if (richText.length === 0) {
        continue;
      }

      if (block.type === 'bulleted_list_item') {
        htmlLines.push(
          `<div style="margin-left:${marginLeft}px;">• ${richText}</div>`,
        );
        numberedCounters.delete(depth);
        continue;
      }

      if (block.type === 'numbered_list_item') {
        const next = (numberedCounters.get(depth) ?? 0) + 1;
        numberedCounters.set(depth, next);
        this.clearDeeperNumbering(numberedCounters, depth);
        htmlLines.push(
          `<div style="margin-left:${marginLeft}px;">${next}. ${richText}</div>`,
        );
        continue;
      }

      numberedCounters.delete(depth);
      this.clearDeeperNumbering(numberedCounters, depth);
      htmlLines.push(
        `<div style="margin-left:${marginLeft}px;">${richText}</div>`,
      );
    }

    return htmlLines.join('');
  }

  private clearDeeperNumbering(
    counters: Map<number, number>,
    depth: number,
  ): void {
    for (const key of Array.from(counters.keys())) {
      if (key > depth) {
        counters.delete(key);
      }
    }
  }

  private extractPlainText(block: BlockObjectResponse): string {
    switch (block.type) {
      case 'paragraph':
        return block.paragraph.rich_text
          .map((text) => text.plain_text)
          .join('');
      case 'bulleted_list_item':
        return block.bulleted_list_item.rich_text
          .map((text) => text.plain_text)
          .join('');
      case 'numbered_list_item':
        return block.numbered_list_item.rich_text
          .map((text) => text.plain_text)
          .join('');
      case 'quote':
        return block.quote.rich_text.map((text) => text.plain_text).join('');
      case 'callout':
        return block.callout.rich_text.map((text) => text.plain_text).join('');
      case 'to_do':
        return block.to_do.rich_text.map((text) => text.plain_text).join('');
      case 'toggle':
        return block.toggle.rich_text.map((text) => text.plain_text).join('');
      case 'heading_1':
        return block.heading_1.rich_text
          .map((text) => text.plain_text)
          .join('');
      case 'heading_2':
        return block.heading_2.rich_text
          .map((text) => text.plain_text)
          .join('');
      case 'heading_3':
        return block.heading_3.rich_text
          .map((text) => text.plain_text)
          .join('');
      case 'code':
        return block.code.rich_text.map((text) => text.plain_text).join('');
      default:
        return '';
    }
  }

  private extractRichText(block: BlockObjectResponse): string {
    switch (block.type) {
      case 'paragraph':
        return this.renderRichText(block.paragraph.rich_text);
      case 'bulleted_list_item':
        return this.renderRichText(block.bulleted_list_item.rich_text);
      case 'numbered_list_item':
        return this.renderRichText(block.numbered_list_item.rich_text);
      case 'quote':
        return this.renderRichText(block.quote.rich_text);
      case 'callout':
        return this.renderRichText(block.callout.rich_text);
      case 'to_do':
        return this.renderRichText(block.to_do.rich_text);
      case 'toggle':
        return this.renderRichText(block.toggle.rich_text);
      case 'heading_1':
        return this.renderRichText(block.heading_1.rich_text);
      case 'heading_2':
        return this.renderRichText(block.heading_2.rich_text);
      case 'heading_3':
        return this.renderRichText(block.heading_3.rich_text);
      case 'code':
        return this.renderRichText(block.code.rich_text);
      default:
        return '';
    }
  }

  private renderRichText(items: RichTextItemResponse[]): string {
    return items.map((item) => this.renderRichTextItem(item)).join('');
  }

  private renderRichTextItem(item: RichTextItemResponse): string {
    let html = this.escapeHtml(item.plain_text);

    if (item.annotations.code) {
      html = `<code>${html}</code>`;
    }
    if (item.annotations.bold) {
      html = `<strong>${html}</strong>`;
    }
    if (item.annotations.italic) {
      html = `<em>${html}</em>`;
    }
    if (item.annotations.underline) {
      html = `<u>${html}</u>`;
    }
    if (item.annotations.strikethrough) {
      html = `<s>${html}</s>`;
    }

    if (item.href != null && item.href.length > 0) {
      html = `<a href="${this.escapeHtml(item.href)}">${html}</a>`;
    }

    return html;
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  private getToggleTitle(toggleBlock: BlockObjectResponse): string {
    if (toggleBlock.type !== 'toggle') {
      return '';
    }

    return toggleBlock.toggle.rich_text
      .map((text) => text.plain_text)
      .join('')
      .trim();
  }

  private isEmptyToggle(toggle: NotionToggle): boolean {
    const hasBody = toggle.bodyText.trim().length > 0;
    const hasBodyHtml = toggle.bodyHtml.trim().length > 0;
    const hasImages = toggle.imageUrls.length > 0;

    return !hasBody && !hasBodyHtml && !hasImages;
  }
}
