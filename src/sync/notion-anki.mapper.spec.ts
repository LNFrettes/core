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
    });

    expect(mapped.deckName).toBe('Mazo Test');
    expect(mapped.front).toBe('Pregunta');
    expect(mapped.backHtml.startsWith('<div style="text-align: left;">')).toBe(
      true,
    );
    expect(mapped.backHtml).toContain('<strong>Respuesta</strong>');
    expect(mapped.backHtml).toContain(
      '<img src="https://example.com/image.png" />',
    );
    expect(mapped.keyTag.startsWith('na_sync_key_')).toBe(true);
    expect(mapped.pageTag.startsWith('na_sync_page_')).toBe(true);
    expect(mapped.hashTag.startsWith('na_sync_hash_')).toBe(true);
  });

  it('mantiene hash estable aunque cambien query params de imagen', () => {
    const withFirstUrl = mapper.mapToggle(basePage, {
      id: 'toggle-2',
      title: 'Pregunta con imagen',
      bodyText: '',
      bodyHtml:
        '<div>Contenido</div><div><img src="https://cdn.notion.site/a.png?X-Amz-Signature=abc&Expires=1" /></div>',
      imageUrls: [],
    });

    const withSecondUrl = mapper.mapToggle(basePage, {
      id: 'toggle-2',
      title: 'Pregunta con imagen',
      bodyText: '',
      bodyHtml:
        '<div>Contenido</div><div><img src="https://cdn.notion.site/a.png?X-Amz-Signature=def&Expires=2" /></div>',
      imageUrls: [],
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
    });

    const spaced = mapper.mapToggle(basePage, {
      id: 'toggle-3',
      title: 'Pregunta con espacios',
      bodyText: '',
      bodyHtml: '<div>Linea 1</div>   <div>Linea 2</div>',
      imageUrls: [],
    });

    expect(compact.hashTag).toBe(spaced.hashTag);
  });
});
