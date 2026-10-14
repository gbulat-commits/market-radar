@AGENTS.md

# Claude Code adapter

Общие правила импортированы выше.

- Проектные skills — `workshop-copilot` (порядок работы) и `debug-by-evidence` (отладка) в `.claude/skills`. Их копии в `.agents/skills` — для Codex, это те же skills, а не вторые.
- Режим Auto пользователь выбирает в переключателе у поля ввода; проектный файл его не включает.
- `.claude/settings.json`: запрет чтения секретов, подтверждение перед `git push`, запрет `git push --force` и `git reset --hard`.
- Если у тебя есть глобальные skills или правила для handoff и планов, в этом проекте веди состояние в файлах Starter: `docs/HANDOFF.md`, `PLANS.md`, `docs/PRODUCT.md`.
