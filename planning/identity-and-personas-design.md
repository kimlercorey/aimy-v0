# Identity and Personas — platform vs entity (2026-10-12)

Kimler's direction, stated 2026-10-12: the product must stop baking in a
single hardcoded persona. Today the app ships one avatar/entity
configuration — "AImy", female, "her" throughout prompts, UI copy,
journal, and voice. The intent is an **identity community**: swappable
personas — the Enterprise computer, HAL, a surfer girl, an Umbrella-style
corporate AI, original characters — where the user picks who their
assistant *is*.

## The separation that stops the bleeding

Two layers, never again conflated:

- **Platform** — the product itself: the workspace, projects, memory,
  knowledge, receipts, sovereignty machinery, and the platform brand
  (logo, app icon, palette, type — see the identity proposal). The
  platform is not a character. It has no gender, no voice, no journal.
- **Entity** — a persona pack installed on the platform: a character
  with a name, pronouns, personality, voice, avatar, and manner. The
  shipped "AImy" configuration is **the default pack**, not the product.
  Every use of "her" in the system is a property of the active pack,
  never of the platform.

## The entity pack

A pack is a bundle (sibling of the capability/skill bundle) with a
manifest declaring:

- `id`, `name`, `pronouns` (she/her, he/him, it/its, they/them, none)
- `personality` — the personality.json shape (dials, desires, register)
- `voice` — TTS voice id + speaking style (pace, warmth, humour)
- `prompts` — the persona sections of the system prompt (identity,
  manner, catchphrase policy, what it never does)
- `avatar` — portrait set + optional entity LoRA (generated imagery)
- `lora` — optional local-model LoRA id; **deployment stays gated on
  user approval** (existing rule), packs declare, the user approves
- `journalVoice` — whether the entity keeps a first-person journal and
  in what register
- `greeting` / wake ritual text

Pack switching is a settings-level act, instant and reversible, like
changing a theme. Installing a pack from the community is a separate,
explicit act with the usual provenance display.

## Continuity rules (the sovereign part)

- Memory, projects, knowledge, journal **history**, receipts, and the
  capability ledger belong to the **user on the platform**. Swapping
  the entity changes who is speaking, never what is remembered.
- A new entity reads the same journal and memory — it inherits the
  relationship's facts, in its own voice. (A "fresh start" reset is a
  separate, explicit, destructive user action — never a side effect of
  switching.)
- Provenance stays honest: receipts and history record which entity
  performed an action (`actor: <pack-id>`), so a swapped-in persona
  never silently owns a predecessor's deeds.

## Stop-the-bleeding rules (effective immediately, all current work)

1. No new hardcoded persona in platform code: UI copy, prompts, logs,
   and docs use the active pack's name/pronouns via tokens, or stay
   neutral. "Her" appears only inside a pack's own files.
2. Brand work (logo, icon, palette, type) is platform-layer and
   persona-free — the identity proposal proceeds unchanged.
3. Onboarding must not hardcode the default entity: the persona step
   is an entity choice whose default selection is the AImy pack.
4. New prompt text goes in a pack-owned section or stays
   platform-neutral; platform prompt sections never assume a character.
5. The journal is addressed to the *active entity slot*, not to a
   hardcoded name; the file and its history stay platform-owned.

## Consequences for work in flight

- Identity proposal (2026-10-12): platform identity — unaffected,
  except onboarding screens that show a face/name are showing the
  default pack and should be labelled as such.
- UI workplan: the Presence panel is the entity control surface (it
  already edits personality.json for the current single entity) — it
  becomes the pack manager (active pack, installed packs, switch).
  Part 2's header presence strip shows the active entity's mark + name.
- Voice: the `narrate` character rules live in the pack's prompt
  section, parametrised by its voice config — not in platform prompt
  text.

## Open decisions

- Pack naming in UI: "Persona", "Entity", "Cast"? (Kimler's word so
  far is entity.)
- Journal voice on swap: does the journal keep one continuous voice,
  or does each entity journal in its own register inside one file?
- Community/licensing: famous characters (HAL, the Enterprise
  computer, Bugs Bunny) are the *shape* of the idea; shipping them is
  a licensing question. The platform ships original packs; community
  packs are user-installed content with provenance shown.
- Per-entity LoRA training/approval flow detail (builds on the gated
  tool/LoRA creation design).
