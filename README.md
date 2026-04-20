# notion-anki-sync core

API simple en NestJS que sincroniza, cada 60 segundos, toggles de páginas de Notion hacia notas de Anki (modelo `Basic`) usando AnkiConnect.

## Flujo

1. Lee páginas habilitadas desde Supabase.
2. Por cada `notion_page_id`, obtiene toggles y sus imágenes desde Notion.
3. Mapea cada toggle a una nota `Basic`:
   - `Front`: título del toggle
   - `Back`: contenido hijo + imágenes
4. Hace upsert en Anki con idempotencia por tags/hash.
5. Elimina notas de Anki cuando el toggle ya no existe en Notion.

## Requisitos

- Node 20+
- pnpm
- Anki abierto con AnkiConnect activo (`http://127.0.0.1:8765`)
- Integración de Notion con acceso a las páginas objetivo
- Supabase con tabla de páginas a sincronizar

## Variables de entorno

Copiar `.env.example` a `.env` y completar:

- `PORT`
- `NOTION_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_SYNC_TABLE` (default: `notion_sync_pages`)
- `ANKI_CONNECT_URL` (default: `http://127.0.0.1:8765`)
- `SYNC_CRON_ENABLED` (default: `true`)
- `SYNC_STARTUP_ENABLED` (default: `true`)

## Esquema esperado en Supabase

Tabla (por defecto): `notion_sync_pages`

Campos mínimos:

- `id` (text/uuid)
- `notion_page_id` (text)
- `deck_name` (text)
- `anki_deck_id` (bigint, nullable, recomendado)
- `enabled` (boolean)
- `updated_at` (timestamp)

## Endpoints

- `GET /` health básico
- `GET /sync/status` estado de corrida actual/última corrida
- `GET /sync/health` salud de dependencias (AnkiConnect)
- `POST /sync/run` dispara sincronización manual
- `POST /sync/reformat` reformatea notas sincronizadas sin resetear repasos

Ejemplos con `curl`:

```bash
# Sincronización manual
curl -X POST http://localhost:3000/sync/run

# Reformateo manual (sin forget de cards)
curl -X POST http://localhost:3000/sync/reformat
```

Además, hay un cron interno cada 60s (`@Cron(CronExpression.EVERY_MINUTE)`).

## Comandos

```bash
pnpm install
pnpm run start:dev
```

Tests:

```bash
pnpm run test
pnpm run test:e2e
```
