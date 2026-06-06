# Conductor Linux

Десктопна апка під Linux для запуску **паралельних сесій Claude Code**, кожна — в ізольованому
**git worktree**. Linux-клон [conductor.build](https://www.conductor.build/).

Кожен воркспейс — це окремий checkout твого репозиторію (git worktree) з власною гілкою, власною
сесією `claude` і власними ресурсами (БД, порт тощо через скрипти). Працюй над кількома задачами
паралельно, не плутаючи їх між собою.

![stack](https://img.shields.io/badge/Electron-React-blue) ![lang](https://img.shields.io/badge/TypeScript-3178c6)

## Можливості

- 🗂️ **Воркспейси на git worktree** — ізольований checkout + гілка `conductor/<name>` на кожну задачу.
- 🤖 **Сесія Claude на воркспейс** — вбудований термінал (`node-pty` + `xterm.js`) із інтерактивним `claude`.
- ⚙️ **Скрипти setup / run / archive** — налаштовувані шляхи; запускаються з env-змінними `CONDUCTOR_*`.
- 🚀 **Неблокуючий UI** — setup і archive виконуються у фоні (бейджі «⏳ налаштування…», «📦 архівується…»);
  можна одразу працювати в інших воркспейсах.
- ▶️⏹️ **Кнопка Run/Stop** — запуск і зупинка застосунку у воркспейсі однією кнопкою.
- 🔒 **Read-only вкладка «Скрипти»** — вивід скриптів захищено від випадкового вводу/`Ctrl+C`.
- 🔢 **Налаштовуваний початковий порт** — воркспейси отримують унікальні порти, починаючи з заданого.

## Інтерфейс

- **Зліва** — список воркспейсів + кнопка «➕ Новий воркспейс».
- **По центру** — дві вкладки:
  - **Claude** — інтерактивна сесія `claude` у директорії воркспейсу.
  - **Скрипти** — вивід setup/run/archive (read-only).
- **Згори** — назва/шлях воркспейсу, кнопка **Run/Stop**, **Архівувати**.
- **⚙ Налаштування** — репозиторій, директорія для worktree, початковий порт і три скрипти.

## Як це працює

| Дія | Що відбувається |
|-----|-----------------|
| Створення воркспейсу | `git worktree add <worktreesDir>/<name> -b conductor/<name>` → у фоні: **setup**-скрипт → старт сесії `claude`. Імʼя автоматично робиться унікальним проти наявних гілок/тек. |
| **Run / Stop** | Run запускає **run**-скрипт у воркспейсі; кнопка стає **Stop** і зупиняє процес. |
| **Архівувати** | у фоні: **archive**-скрипт → завершення PTY → `git worktree remove --force` → воркспейс зникає зі списку. |

Авторизація Claude береться з уже залогіненого `claude` CLI.

### Env-змінні для скриптів (сумісно з Conductor)

| Змінна | Значення |
|--------|----------|
| `CONDUCTOR_WORKSPACE_PATH` | абсолютний шлях директорії воркспейсу (worktree) |
| `CONDUCTOR_ROOT_PATH` | корінь головного репозиторію |
| `CONDUCTOR_WORKSPACE_NAME` | імʼя воркспейсу |
| `CONDUCTOR_PORT` | унікальний порт воркспейсу (від «початкового порту» з Налаштувань) |

У `scripts/` є приклади `setup.sh` / `run.sh` / `archive.sh` для перевірки.

## Архітектура

```
src/
  main/        # Electron main: вікно, git worktree, запуск скриптів, node-pty, персист стану
    index.ts ipc.ts store.ts env.ts git.ts ptyManager.ts workspaces.ts
  preload/     # contextBridge → typed window.api (contextIsolation)
  renderer/    # React + Vite: Sidebar, Toolbar, TerminalView, SettingsModal, NewWorkspaceModal
  shared/      # спільні типи
```

**Стек:** Electron + React + TypeScript, `node-pty` + `@xterm/xterm`, `zustand`, `electron-vite`.

## Розробка

```bash
npm install          # автоматично ребілдить node-pty під ABI Electron (postinstall)
npm run dev          # режим розробки
npm run build        # збірка main/preload/renderer у out/
npm run dist         # збірка AppImage/deb (electron-builder)
```

Потрібні: **Node 20+**, `git`, встановлений CLI **`claude`** у `PATH`.

## Налаштування

При першому запуску відкриється вікно Налаштувань. Вкажи:

- **Репозиторій** — головний git-репозиторій, з якого створюються worktree.
- **Директорія для worktree** — де зберігати воркспейси (дефолт `~/.conductor-linux/worktrees`).
- **Початковий порт** — з якого числа роздавати `CONDUCTOR_PORT` (дефолт `3002`).
- **Setup / Run / Archive** — шляхи до скриптів (опційно).
