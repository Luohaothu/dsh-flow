# Domain Docs

## Layout

Single-context: one root `GLOSSARY.md` for shared vocabulary; `docs/design/design.md` is the sole source for architecture and design decisions across the workspace.

```text
/
├── GLOSSARY.md
├── docs/design/design.md
└── packages/
    ├── dsh-flow/
    └── typert-protocol/
```

## Before exploring the codebase

Read the root `GLOSSARY.md` and the sections of `docs/design/design.md` relevant to the area being changed.

If a referenced file or directory is absent, proceed silently. The `/domain-modeling` skill creates glossaries lazily when terminology is resolved.

## Use the glossary's vocabulary

Use defined terms in issue titles, proposals, hypotheses, and test names. If a needed concept is missing, reconsider whether it belongs to the project; record genuine terminology gaps for `/domain-modeling`.

## Surface design conflicts

If a proposal conflicts with `docs/design/design.md`, identify the section and explain why it should be reconsidered; do not edit `design.md` unless the user explicitly asks.
