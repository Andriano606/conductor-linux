# Conductor Linux

Десктопна апка під Linux для запуску паралельних сесій **Claude Code**, кожна в ізольованому
**git worktree**. Linux-клон [conductor.build](https://www.conductor.build/).

- **Зліва** — список воркспейсів + кнопка створення.
- **По центру** — вбудований термінал із сесією `claude` для активного воркспейсу (вкладка «Claude»)
  та вивід скриптів (вкладка «Скрипти»).
- **⚙ Налаштування** — шляхи до трьох скриптів **setup / run / archive** і репозиторію.

## Як це працює

| Дія | Що відбувається |
|-----|-----------------|
| Створення воркспейсу | `git worktree add <dir>/<name> -b conductor/<name>` → запуск **setup**-скрипта → старт сесії `claude` у директорії worktree |
| Кнопка **Run** | запуск **run**-скрипта у воркспейсі |
| **Архівувати** | запуск **archive**-скрипта → завершення PTY → `git worktree remove --force` |

Скриптам доступні env-змінні (сумісно з Conductor):
`CONDUCTOR_WORKSPACE_PATH`, `CONDUCTOR_ROOT_PATH`, `CONDUCTOR_WORKSPACE_NAME`, `CONDUCTOR_PORT`.

## Розробка

```bash
npm install          # автоматично ребілдить node-pty під ABI Electron (postinstall)
npm run dev          # запуск у режимі розробки
npm run build        # збірка main/preload/renderer у out/
npm run dist         # збірка AppImage/deb (electron-builder)
```

Потрібні: Node 20+, `git`, встановлений CLI `claude` у PATH.

У `scripts/` є приклади setup/run/archive для перевірки.
