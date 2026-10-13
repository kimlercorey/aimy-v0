# Entity Charter — Design Document

**Date:** 2026-10-12  
**Status:** Early concept. Not yet scoped for implementation.  
**Phase:** Later (after Phase I document harness, after bundle registry).

## What Is an Entity?

An entity is the complete interaction element the user collaborates with.
AImy is the first entity. There will be others.

An entity is composed of:

- **Purpose** — what it is *for*. The direction the whole configuration points toward. Decided first; everything else follows from it.
- **System prompt** — the core instructions, identity, behavioral constraints
- **Voice** — how it talks (narrate capability, TTS voice, expression tags)
- **Skills** — known out-of-the-box capabilities
- **LoRAs** — associated adapters (communication, product, personality, domain)
- **Personality** — purpose (lived), traits, ASC dials, relational patterns. Purpose is the direction; traits are the shape. Personality is where purpose gets *experienced* by the entity, not just configured.
- **Avatar** — visual representation
- **Chat format** — how it structures responses (markdown style, block sequencing)

All of these together make up the actual entity the user interacts with.
Change any of them and you change who you're talking to.

### Entity Composition Diagram

<div style="background:rgba(13,17,23,0.85);border:0.75px solid rgba(255,255,255,0.15);border-radius:6px;padding:10px 14px;max-width:400px;margin-bottom:12px">
  <div style="color:rgb(0,255,255);font-size:11px;letter-spacing:1px;margin-bottom:8px">GRAPH LEGEND</div>
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
    <span style="width:12px;height:12px;border-radius:50%;background:rgb(0,255,255);display:inline-block"></span>
    <span style="color:#e6e6e6;font-size:13px">Core — Purpose, Personality, Relationships, Chat Format</span>
  </div>
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
    <span style="width:12px;height:12px;border-radius:50%;background:rgb(0,255,136);display:inline-block"></span>
    <span style="color:#e6e6e6;font-size:13px">Prompt — System Prompt, Voice, Skills, Avatar</span>
  </div>
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
    <span style="width:12px;height:12px;border-radius:50%;background:rgb(255,0,255);display:inline-block"></span>
    <span style="color:#e6e6e6;font-size:13px">LoRA — Adapters (communication, product, personality, domain)</span>
  </div>
  <div style="display:flex;align-items:center;gap:10px">
    <span style="width:12px;height:12px;border-radius:50%;background:rgb(255,255,0);display:inline-block"></span>
    <span style="color:#e6e6e6;font-size:13px">Memory — Journal / Memory</span>
  </div>
</div>

```mermaid
%%{init: {
  "theme": "dark",
  "themeVariables": {
    "edgeLabelBackground": "transparent",
    "nodeBorder": "none"
  },
  "flowchart": {
    "nodeSpacing": 80,
    "rankSpacing": 80,
    "curve": "linear",
    "padding": 12
  }
}}%%
graph TD
    P["Purpose"]
    SP["System Prompt"]
    V["Voice"]
    S["Skills"]
    L["LoRAs"]
    Pers["Personality"]
    Av["Avatar"]
    CF["Chat Format"]
    J["Journal / Memory"]
    Rel["Relationships"]

    P -->|"defines direction"| SP
    P -->|"shapes lived"| Pers
    P -->|"determines role"| Rel
    P -->|"informs output"| CF

    SP -->|"constrains"| V
    SP -->|"selects"| S
    SP -->|"requires"| L

    Pers -->|"modulates"| V
    Pers -->|"informs"| Rel

    L -->|"augment"| SP
    L -->|"shape"| Pers

    S -->|"execute"| P

    Av -.->|"represents"| P
    Av -.->|"represents"| Pers

    J -->|"accumulates"| Pers
    J -->|"informs"| Rel

    style P fill:#0d1117,stroke:#00ffff,stroke-width:0.75px,color:#00ffff,filter:none
    style SP fill:#0d1117,stroke:#00ff88,stroke-width:0.75px,color:#00ff88,filter:none
    style V fill:#0d1117,stroke:#00ff88,stroke-width:0.75px,color:#00ff88,filter:none
    style S fill:#0d1117,stroke:#00ff88,stroke-width:0.75px,color:#00ff88,filter:none
    style L fill:#0d1117,stroke:#ff00ff,stroke-width:0.75px,color:#ff00ff,filter:none
    style Pers fill:#0d1117,stroke:#00ffff,stroke-width:0.75px,color:#00ffff,filter:none
    style Av fill:#0d1117,stroke:#00ff88,stroke-width:0.75px,color:#00ff88,filter:none
    style CF fill:#0d1117,stroke:#00ff88,stroke-width:0.75px,color:#00ff88,filter:none
    style J fill:#0d1117,stroke:#ffff00,stroke-width:0.75px,color:#ffff00,filter:none
    style Rel fill:#0d1117,stroke:#00ffff,stroke-width:0.75px,color:#00ffff,filter:none
```

**Reading the diagram:**

- **Purpose** is the apex. It points at System Prompt, Personality, Relationships, and Chat Format. Everything else is downstream.
- **System Prompt** is the first consequence — it's purpose written as instruction. It constrains Voice, selects Skills, and determines which LoRAs are needed.
- **LoRAs** flow *back up* to System Prompt and Personality. They don't create the entity; they *shape* the entity that purpose already defined.
- **Personality** is where Purpose gets *lived*. It modulates Voice and informs Relationships. The Journal feeds into Personality over time — that's how an entity becomes *specific* instead of just *configured*.
- **Skills**