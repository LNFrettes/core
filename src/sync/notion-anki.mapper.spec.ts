import { NotionAnkiMapper } from './notion-anki.mapper';

describe('NotionAnkiMapper', () => {
  const mapper = new NotionAnkiMapper();
  const basePage = {
    id: 'row-1',
    notionPageId: 'page-123',
    deckName: 'Mazo Test',
    ankiDeckId: 123,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };

  it('mapea toggle a nota basic con tags y html', () => {
    const mapped = mapper.mapToggle(basePage, {
      id: 'toggle-1',
      title: 'Pregunta',
      bodyText: 'Respuesta\nSegunda linea',
      bodyHtml: '<div><strong>Respuesta</strong></div><div>Segunda linea</div>',
      imageUrls: ['https://example.com/image.png'],
      lastEditedTime: '2023-01-01T00:00:00.000Z',
    });

    expect(mapped.deckName).toBe('Mazo Test');
    expect(mapped.front).toBe('Pregunta');
    expect(mapped.backHtml.startsWith('<div style="text-align: left;">')).toBe(
      true,
    );
    expect(mapped.backHtml).toContain('<strong>Respuesta</strong>');
    expect(mapped.backHtml).toContain('<img src="na_sync_');
    expect(mapped.keyTag.startsWith('na_sync_key_')).toBe(true);
    expect(mapped.pageTag.startsWith('na_sync_page_')).toBe(true);
    expect(mapped.hashTag.startsWith('na_sync_hash_')).toBe(true);
    expect(mapped.mediaFiles).toHaveLength(1);
    expect(mapped.mediaFiles?.[0]?.sourceUrl).toBe(
      'https://example.com/image.png',
    );
    expect(mapped.mediaFiles?.[0]?.filename).toMatch(/^na_sync_/);
  });

  it('mantiene hash estable aunque cambien query params de imagen', () => {
    const withFirstUrl = mapper.mapToggle(basePage, {
      id: 'toggle-2',
      title: 'Pregunta con imagen',
      bodyText: '',
      bodyHtml:
        '<div>Contenido</div><div><img src="https://cdn.notion.site/a.png?X-Amz-Signature=abc&Expires=1" /></div>',
      imageUrls: [
        'https://cdn.notion.site/a.png?X-Amz-Signature=abc&Expires=1',
      ],
      lastEditedTime: '2023-01-01T00:00:00.000Z',
    });

    const withSecondUrl = mapper.mapToggle(basePage, {
      id: 'toggle-2',
      title: 'Pregunta con imagen',
      bodyText: '',
      bodyHtml:
        '<div>Contenido</div><div><img src="https://cdn.notion.site/a.png?X-Amz-Signature=def&Expires=2" /></div>',
      imageUrls: [
        'https://cdn.notion.site/a.png?X-Amz-Signature=def&Expires=2',
      ],
      lastEditedTime: '2023-01-01T00:00:00.000Z',
    });

    expect(withFirstUrl.hashTag).toBe(withSecondUrl.hashTag);
  });

  it('mantiene hash estable ante diferencias cosméticas de espacios', () => {
    const compact = mapper.mapToggle(basePage, {
      id: 'toggle-3',
      title: 'Pregunta   con   espacios',
      bodyText: '',
      bodyHtml: '<div>Linea 1</div><div>Linea 2</div>',
      imageUrls: [],
      lastEditedTime: '2023-01-01T00:00:00.000Z',
    });

    const spaced = mapper.mapToggle(basePage, {
      id: 'toggle-3',
      title: 'Pregunta con espacios',
      bodyText: '',
      bodyHtml: '<div>Linea 1</div>   <div>Linea 2</div>',
      imageUrls: [],
      lastEditedTime: '2023-01-01T00:00:00.000Z',
    });

    expect(compact.hashTag).toBe(spaced.hashTag);
  });

  it('reemplaza src de imágenes del bodyHtml por filenames embebidos', () => {
    const mapped = mapper.mapToggle(basePage, {
      id: 'toggle-4',
      title: 'Pregunta con img inline',
      bodyText: '',
      bodyHtml:
        '<div>Contenido</div><div><img src="https://example.com/inline.png?token=123" /></div>',
      imageUrls: ['https://example.com/inline.png?token=123'],
      lastEditedTime: '2023-01-01T00:00:00.000Z',
    });

    expect(mapped.backHtml).toContain('<img src="na_sync_');
    expect(mapped.backHtml).not.toContain('https://example.com/inline.png');
    expect(mapped.mediaFiles?.[0]?.filename).toContain('.png');
  });

  it('mantiene filename y hash cuando cambia la URL firmada de Notion', () => {
    const first = mapper.mapToggle(basePage, {
      id: 'toggle-5',
      title: 'Pregunta con media estable',
      bodyText: '',
      bodyHtml:
        '<div><img src="https://prod-files-secure.s3.us-west-2.amazonaws.com/path-a/file.png?X-Amz-Signature=111" /></div>',
      imageUrls: [
        'https://prod-files-secure.s3.us-west-2.amazonaws.com/path-a/file.png?X-Amz-Signature=111',
      ],
      lastEditedTime: '2023-01-01T00:00:00.000Z',
    });

    const second = mapper.mapToggle(basePage, {
      id: 'toggle-5',
      title: 'Pregunta con media estable',
      bodyText: '',
      bodyHtml:
        '<div><img src="https://prod-files-secure.s3.us-west-2.amazonaws.com/path-b/file.png?X-Amz-Signature=999" /></div>',
      imageUrls: [
        'https://prod-files-secure.s3.us-west-2.amazonaws.com/path-b/file.png?X-Amz-Signature=999',
      ],
      lastEditedTime: '2023-01-01T00:00:00.000Z',
    });

    expect(first.mediaFiles?.[0]?.filename).toBe(
      second.mediaFiles?.[0]?.filename,
    );
    expect(first.backHtml).toBe(second.backHtml);
    expect(first.hashTag).toBe(second.hashTag);
  });
});
