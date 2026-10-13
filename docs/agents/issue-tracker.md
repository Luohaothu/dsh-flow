# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `Luohaothu/dsh-flow`. Use the `gh` CLI inside this clone; when working elsewhere, pass `--repo Luohaothu/dsh-flow`.

## Ticket operations

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`; apply `--label`, `--state`, and `--limit` for the required scope.
- Comment: `gh issue comment <number> --body-file <file>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`; use the mapping in `docs/agents/triage-labels.md`.
- Close: `gh issue close <number>`; use `--comment "..."` when an explanation is needed.
- Make a sub-issue: `gh issue create --parent <parent> --title "..." --body-file <file>`, or `gh issue edit <parent> --add-sub-issue <child>`.
- If sub-issues are unavailable, put `Part of #<parent>` at the top of the child body and add it to a task list in the parent.

For multiline bodies, write the exact text to a temporary file and use `--body-file`.

When a skill says "publish to the issue tracker", create a GitHub issue. When it says "fetch the relevant ticket", read the issue and its comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and PRs. If a reference is ambiguous, resolve it with `gh pr view <number>` and fall back to `gh issue view <number>`.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue with child issues as tickets.

- Map: create an issue labelled `wayfinder:map`, with Notes, Decisions-so-far, and Fog sections.
- Child ticket: link it to the map as a sub-issue, or use the parent/task-list fallback above. Label it `wayfinder:<type>`, where type is `research`, `prototype`, `grilling`, or `task`.
- Blocking: use native issue dependencies. Add an edge with `gh api --method POST repos/Luohaothu/dsh-flow/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Get the database ID with `gh api repos/Luohaothu/dsh-flow/issues/<blocker> --jq .id`; it is not the issue number or node ID. If dependencies are unavailable, put `Blocked by: #<n>, #<n>` at the top of the child body.
- Frontier: inspect the map's open children in map order. Exclude assigned tickets and tickets with open blockers; native `issue_dependencies_summary.blocked_by` counts open blockers. For the text fallback, check each listed blocker's state. Select the first remaining ticket.
- Claim: assign the selected ticket to the driving developer; for the current account use `gh issue edit <number> --add-assignee @me`.
- Resolve: comment with the answer, close the child issue, then append a concise result and link to the map's Decisions-so-far.

Create any missing `wayfinder:*` labels when that workflow is used.
