# Zeno Wallet Telegram Bot

Telegram-бот для заработка монет и перевода заработанного баланса в Zeno.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

- `/start` показывает приветствие и список команд.
- `/case` начисляет случайную награду от 5 до 100 монет.
- `/daily` начисляет 10 монет раз в 24 часа.
- `/referral` выдаёт персональную ссылку и начисляет пригласившему 50 монет за нового пользователя.
- `/balance` показывает заработанный баланс и баланс Zeno.
- `/withdraw [сумма]` переводит сумму из `earn_balance` в `zeno_balance`.

Supabase SQL для таблицы кошелька находится в `supabase/schema.sql`. Перед первым запуском его нужно выполнить в SQL Editor Supabase.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Бот работает в режиме long polling; не запускайте несколько экземпляров одновременно с одним BOT_TOKEN.
- `BOT_TOKEN`, `SUPABASE_URL` и `SUPABASE_KEY` должны быть добавлены в Secrets.
- Сервер использует Supabase REST API напрямую и не передаёт ключ в Telegram или клиентский код.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
