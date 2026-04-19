import { ConfigService } from '@nestjs/config';
import type {
  BlockObjectResponse,
  ListBlockChildrenResponse,
} from '@notionhq/client/build/src/api-endpoints';
import { NotionSyncClient } from './notion-sync.client';

function richText(plainText: string) {
  return [
    {
      type: 'text' as const,
      plain_text: plainText,
      href: null,
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default' as const,
      },
      text: {
        content: plainText,
        link: null,
      },
    },
  ];
}

function toggleBlock(
  id: string,
  title: string,
  hasChildren: boolean,
): BlockObjectResponse {
  return {
    object: 'block',
    id,
    parent: { type: 'page_id', page_id: 'page-1' },
    created_time: '2026-01-01T00:00:00.000Z',
    last_edited_time: '2026-01-01T00:00:00.000Z',
    created_by: { object: 'user', id: 'user-1' },
    last_edited_by: { object: 'user', id: 'user-1' },
    has_children: hasChildren,
    archived: false,
    in_trash: false,
    type: 'toggle',
    toggle: {
      rich_text: richText(title),
      color: 'default',
    },
  } as unknown as BlockObjectResponse;
}

function paragraphBlock(id: string, text: string): BlockObjectResponse {
  return {
    object: 'block',
    id,
    parent: { type: 'page_id', page_id: 'page-1' },
    created_time: '2026-01-01T00:00:00.000Z',
    last_edited_time: '2026-01-01T00:00:00.000Z',
    created_by: { object: 'user', id: 'user-1' },
    last_edited_by: { object: 'user', id: 'user-1' },
    has_children: false,
    archived: false,
    in_trash: false,
    type: 'paragraph',
    paragraph: {
      rich_text: richText(text),
      color: 'default',
    },
  } as unknown as BlockObjectResponse;
}

describe('NotionSyncClient', () => {
  it('excluye toggle contenedor h4-1 e incluye solo hijos directos de texto', async () => {
    const configService = {
      getOrThrow: jest.fn().mockReturnValue('notion-token'),
    } as unknown as ConfigService;

    const client = new NotionSyncClient(configService);

    const blocksByParent = new Map<string, BlockObjectResponse[]>([
      [
        'page-1',
        [
          toggleBlock('toggle-h4', 'h4-1 Contenedor', true),
          toggleBlock('toggle-normal', 'Pregunta normal', true),
        ],
      ],
      [
        'toggle-h4',
        [toggleBlock('toggle-child-direct', 'Hijo directo válido', true)],
      ],
      [
        'toggle-child-direct',
        [
          toggleBlock(
            'toggle-grandchild',
            'Nieto (no debe crear tarjeta)',
            true,
          ),
          paragraphBlock('p-child', 'Respuesta del hijo directo'),
        ],
      ],
      [
        'toggle-grandchild',
        [paragraphBlock('p-grandchild', 'Respuesta nieto')],
      ],
      ['toggle-normal', [paragraphBlock('p-normal', 'Respuesta normal')]],
    ]);

    const listMock = jest.fn(
      ({
        block_id,
      }: {
        block_id: string;
      }): Promise<ListBlockChildrenResponse> =>
        Promise.resolve({
          object: 'list',
          results: blocksByParent.get(block_id) ?? [],
          has_more: false,
          next_cursor: null,
          type: 'block',
          block: {},
          request_id: 'req-1',
        } as unknown as ListBlockChildrenResponse),
    );

    (client as unknown as { client: unknown }).client = {
      blocks: {
        children: {
          list: listMock,
        },
      },
    };

    const toggles = await client.getPageToggles('page-1');

    expect(toggles.map((toggle) => toggle.id)).toEqual(
      expect.arrayContaining(['toggle-child-direct', 'toggle-normal']),
    );
    expect(toggles).toHaveLength(2);
    expect(toggles.find((toggle) => toggle.id === 'toggle-h4')).toBeUndefined();
    expect(
      toggles.find((toggle) => toggle.id === 'toggle-grandchild'),
    ).toBeUndefined();
  });
});
