# Mission Planner — Development Rules

## Agent 1 — Map Cleaner
- Implement obstacle erasing and wall completion.
- Maintain a separate editable planning map.
- Do not modify ROKIT navigation or safety systems.
- Only modify UI components required for map editing.

## Agent 2 — UI Improvements
- Improve layout, styling and user experience.
- Preserve existing functionality.
- Do not modify map-processing or navigation logic.

## Shared Rules
- Each agent must work in a separate Git worktree.
- Avoid modifying files owned by the other agent.
- Report changes requiring shared components.
- Preserve existing API contracts.
- Run relevant tests before committing.
- Never merge directly into main.