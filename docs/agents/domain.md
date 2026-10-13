# Domain Docs

## Layout

Single-context: one root `GLOSSARY.md` for shared vocabulary and `docs/adr/` for architecture decisions across the workspace.

```text
/
├── GLOSSARY.md
├── docs/adr/
└── packages/
    ├── dsh-flow/
    └── typert-protocol/
```

## Before exploring the codebase

Read the root `GLOSSARY.md` and ADRs in `docs/adr/` relevant to the area being changed.

If a referenced file or directory is absent, proceed silently. The `/domain-modeling` skill creates glossaries and ADRs lazily when terminology or decisions are resolved.

## Use the glossary's vocabulary

Use defined terms in issue titles, proposals, hypotheses, and test names. If a needed concept is missing, reconsider whether it belongs to the project; record genuine terminology gaps for `/domain-modeling`.

## Surface ADR conflicts

Respect explicit supersession recorded in ADRs. If a proposal conflicts with an applicable decision, identify the ADR and explain why it should be reconsidered.
