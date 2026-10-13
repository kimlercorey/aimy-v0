# docs/

Final product and developer documents ready for delivery.

## Convention

- **`planning/`** (repo root) — idea evolution and work in progress. Specs,
  MoSCoW lists, architecture sketches, research notes. These evolve; they may
  be messy, incomplete, or superseded. This is where thinking happens.
- **`docs/`** (here) — finished documents. Product specs, developer guides,
  API references, user manuals. These are reviewed, stable, and ready for
  someone else to read. If it's not ready for delivery, it belongs in
  `planning/`, not here.
- **`core/bundles/DESIGN.md`** and similar — design docs co-located with code
  (per project convention: docs stay near the code they describe for
  AI-ingestion locality). These are working design documents, not final
  deliverables.

## Rule

Documents live in one of these three places. Nowhere else. No proliferation
across the hard drive, no `~/Documents/aimy-stuff/`, no Desktop folders.
If you're writing it, it goes in `planning/`. If it's done, it moves to
`docs/`. If it describes code, it lives next to the code.
