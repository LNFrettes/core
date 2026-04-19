export interface SyncPageRecord {
  id: string;
  notionPageId: string;
  deckName: string;
  ankiDeckId: number | null;
  enabled: boolean;
  updatedAt: string;
}

export interface NotionToggle {
  id: string;
  title: string;
  bodyText: string;
  bodyHtml: string;
  imageUrls: string[];
}

export interface MappedAnkiNote {
  keyTag: string;
  pageTag: string;
  hashTag: string;
  deckName: string;
  front: string;
  backHtml: string;
  diagnostics?: {
    titleLength: number;
    backHtmlLength: number;
    backHtmlHashShort: string;
    imageCount: number;
    hasBodyHtml: boolean;
    hasBodyText: boolean;
  };
}

export interface PageSyncStats {
  notionPageId: string;
  deckName: string;
  togglesRead: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  failed: number;
  errors: string[];
}

export interface SyncRunReport {
  trigger: 'cron' | 'manual';
  startedAt: string;
  finishedAt: string;
  pagesRead: number;
  togglesRead: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  failed: number;
  pageStats: PageSyncStats[];
}

export interface ReformatPageStats {
  notionPageId: string;
  deckName: string;
  notesTargeted: number;
  reformatted: number;
  unchanged: number;
  missing: number;
  failed: number;
  errors: string[];
}

export interface ReformatRunReport {
  trigger: 'manual';
  startedAt: string;
  finishedAt: string;
  pagesRead: number;
  notesTargeted: number;
  reformatted: number;
  unchanged: number;
  missing: number;
  failed: number;
  pageStats: ReformatPageStats[];
}
