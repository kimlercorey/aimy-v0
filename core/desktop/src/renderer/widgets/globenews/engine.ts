/**
 * widgets/globenews/engine.ts — GlobeNews: the vector earth
 * (2026-10-13; moved into the widget's folder the same day — all
 * GlobeNews code lives with the widget).
 *
 * A dotted earth from real coastlines (Natural Earth land
 * polygons rasterised at 1440×576), phosphor above the horizon,
 * its ember reflection warped below — the outer world, spinning
 * slowly, wrapped in a cyan rim glow. GRABBABLE: drag to
 * reposition the spin and set the tilt; release and it keeps
 * turning, fling inertia easing back to the base rate. A CAMERA
 * (Threat Channel): the wheel zooms, the point cloud re-resolves
 * with depth, and an idle director flies to featured threats
 * with tactical overlays (rings, arcs, lock-on, readouts).
 *
 * A HomeDash widget engine: it mounts on .mirror-field-hook
 * inside the dash stage and reads its settings (spin, density,
 * glow, tilt) from the hook's hidden .mirror-field-settings span —
 * values the widget declared in its manifest and the user set in
 * Settings. Renderer-owned DOM effect (the mermaid.ts pattern).
 * Guardrails: loop dies with the element, pauses when hidden,
 * reduced motion gets one static frame (drag still re-frames).
 */
// ── Pure geometry (unit-tested from the harness) ────────────────────

export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

export const rotateY = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c }
}

export const rotateX = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c }
}

export const rotateZ = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z }
}

/** Perspective projection (y-up world → y-down screen; front is -z). */
export const project = (
  v: Vec3,
  cx: number,
  cy: number,
  scale: number,
  focal: number,
): { readonly x: number; readonly y: number } => {
  const k = focal / (focal + v.z)
  return { x: cx + v.x * scale * k, y: cy - v.y * scale * k }
}

/** Mirror a screen y across a horizontal axis (the horizon). */
export const reflectY = (y: number, axis: number): number => 2 * axis - y

// ── Land mask ───────────────────────────────────────────────────────
// Coastlines: Natural Earth land polygons (public domain)
// rasterised to a 1440×576 equirectangular grid (0.25° cells).
// Stored as row spans (start,length uint16 pairs, 0xFFFF ends
// a row), base64 — decoded to a bitset once at first use.
// The fine grid is what lets the camera descend: sampling
// steps shrink with zoom and the point cloud re-resolves
// instead of fattening (2026-10-13).

export const LAND_W = 1440
export const LAND_H = 576
const LAND_SPANS_B64 =
  "//////////////////////////////////////////////////////////////////////////////////////////////////////////8CPA" +
  "AV/////wIxADv/////AYkARAIcAFn/////AYUAUwIVAGf/////AXUAZAIEAAUCFABi/////wFlAGwB3gAcAf4AFQIXAE4CcgAD/////wFiAGMB" +
  "1QCjAocAFv////8BZABlAdYAoAJ6ACX/////AVUACwFoAFwBzgDNBEkACv////8BUQASAWwAUgHIAMwDjwADA5UABwRDABX/////AU8AHQGIAD" +
  "EBwgDMAxwACQMpAAsDiwAPBD4AHf////8BTQAlAXQADQGDADQBwADEAxcAJQOLAAgEQQAd/////wFOACYBdQA/AcgAwAL/AAcDDQAKAx8AHQRD" +
  "AB7/////AVEAJQF4ADIByQC9AvoAIwMiABYERAAd/////wEqAAUBWQAeAXsAJgHDAMEC+wAnBEgAGQRkAAn/////ASoAEAFYABoBdwApAboAyA" +
  "L8ACkEUQAPBGMAEP////8BDgAMAS4AEQFFAAsBWQAWAXIAMAGwANIC/wAeBGEAFf////8BNQALAUYADAFgAAwBcwAtAasA1wMCABoDJAAJBF8A" +
  "FP////8BDAANAT0ABQFJAAYBcQABAXgAIgGsANYDBQAWAyUACwReAAP/////AQsADAFOAAsBbwALAXsAHQGzAM8DCQAOAyMADARwAAP/////AP" +
  "EADgFwACQBwADEAwcADwRpAA//////AO0AEgFMAAsBbAAmAbMA0wMLAAoEZQAU/////wDqABQBGAAFAUUAAgFLABgBaQAvAbUAxwPXAAwEYwAa" +
  "BIAABf////8A5wAQAQEABAEWAAkBOwAOAVIAEwFyAA4BhQANAbkAxAPPABQEWwA3/////wDlAA0A/gARARgACAE1ABUBWgALAb0ABgHbAKYDwQ" +
  "AcBEoABwRVAEIE+gAM/////wD8ABYBGQAQATUAFQFcAA4BhAACAeAAogO7ABkEQwBWBPUAGv////8A+gAwATwADQFQAAcBXAAzAeUAnQO1ABcE" +
  "NgBiBPQAIAUZAAL/////APsALQE8AAwBTQAMAV0ANAHlAJkDrwAWBDEAZAT1AB4FGAAR/////wEKABABTgALAV4AMgHoAJgDrwASBCoAZgT4AA" +
  "sFBAAOBR4AC/////8BCAAKAWgAGQGEAAcB6wCXA64ADwQoAGL/////ANwAGAHsAI4DqwAPBCkAXf////8A3gAgAVIAEwHuAJADpwARBCkAZQSS" +
  "AAP/////AN8AIgElAAcBPAAQAVAAFQFwAAgBggAGAYwADQHvAI8DqQANBBIAhASXABQEvAAIBQEADP////8A3gAhAQIAAgElAAkBOgARAU8AFA" +
  "FrAAwBfAAOAYwAEQHxAIEDpgAOBBIAmgS8ABQFAgAN/////wDcAB4A/QAKAR4ADgE8AA0BTwASAWkADgF6ABIBjwAQAfIAgwOjAA8D5gAFBBIA" +
  "wf////8A2wAbAPgAGgEVAAcBHwAMATYAFwFQAAsBaAAmAZcABAH0AIMDoQAPA+QADwP6AAQEEgDCBP8ADv////8A2gAYAPYAJwEgAAwBOAAWAV" +
  "EACAFnACcBlAAMAfMAegJzAAQDoQANA+MAEAP7AAQEEwDBBPwAI/////8A2AAYAPQAKgEhAAwBPAASAVYAAQFnAD4B8gCBA54AEQPiABED+gAF" +
  "BAIAEQQUAL8E/QAq/////wDaABUA8wA6AUAADgFRAAgBZwBBAfAAhgOeABED4AARA/cABwQAANQE4AADBP4AK/////8AAAAHAOAADwD2ADgBQg" +
  "AHAU8ADQFoAEABqgAHAfkAfwOgABAD3QATA/QACgQAANYE3wAWBPYANwWeAAL/////AAAACQBaAAsA4gAGAPoANAFOABABbABHAfwAbwJsAA0D" +
  "PQAGA6UADgPbABcD9gDjBN4AUwWaAAb/////AFEAHwD3ADsBTgASAWoATQH2AAYCAABsAm8ACgMwABgDpgAQA9oAGQP4AVUFmwAB/////wBMAC" +
  "gAdgAFAM8AAQEKACwBTgATAWwAUgH1AHQDLgAfA9sAGQP5AVf/////AEYAQQDHAAMAzgAGAN4AAQEAADsBTgAUAXYASwH1AH8DIwAmA9wAGAP4" +
  "AVj/////AEQAVADAABcA2wAEAOUAAgD7AEEBRQAHAVAAEAF5AAQBhAANAZcAKwH1AH8DHQAuA08AAwPCAAED3AAXA/cBWAV4AA4FigAG/////w" +
  "BDAF8AtAArAOIADAD9ADsBQgANAVMAEgF5AA4BnAAnAfYACgIEAGwDGgA7A8AADwPbABgD9gFdBVYAEAVrAAUFeAAg/////wBBAGYAsABFAP8A" +
  "AwEEADMBQwAOAVYAEAFqAAIBeQASAZ4AJgIDAGkDFwBEA8IAEgPgABMD9wF8BXoAI/////8AAAABADwAwQEJABYBLwAIAUwABAFWABABaAAGAX" +
  "kAEwGcACQCAgBmAxQAUQPEABQD4gASA/sBegV5ACf/////AAAABQA1ANIBCgAGAR4ADQFWABoBeQASAaMAHAH/AGQDEgBXA6IABwO3AAcDwQAb" +
  "A+QAEgP6Aab/////AAAACQA2ANIBHQAQAUUACgFVABsBdwASAaAAAQGoABwB+wBgAw8AXgN/AAkDnQAKA6wANAPjABQD+gGm/////wAAAA0AOw" +
  "DJARcAAgEgABYBRgAKAVEAHgF2ABQBnAAIAasAHwH6AFYDDABlA4AACwOYAF4D+wGl/////wAAABAAPQDeAR4AUgF1ABYBmwAJAawAIgH5AFQD" +
  "CgBpA38ACwOSAGMD+wGl/////wAAABMAPwEzAXMAGAGbAAgBrQAjAfgAUwMIAG0DfgAJA5AAYwP5Aaf/////AAAAGABCAUgBrAAmAfkAUQMHAG" +
  "4DgAAHA48AYwP4Aaj/////AAAAFQAWAA0ARgFBAaoALwH6AE4DBQBSA1gAHAOCAAcDigBmA/YBqv////8AAAAlADoACABHATIBewAIAagAMAH5" +
  "AEsCdwABAo0ACQMEAFMDXwATA3cABgOAAG4D8gGu/////wAAACgANQAMAEQBNAGnABkBxwAQAfkARwJwAAsCgQAHAooADAMCAFgDZwAFA3QCLP" +
  "////8AAAABAAQAIwAxAUYBpgAaAckADQH7AD4CbwAnAwAAKwMyACoDcQIv/////wAAAAMABgAEAAwAFAAxAUUBeAAEAagAGgHLAAkB/QA1AnMA" +
  "JQL/ACkDNQAnA28CMf////8AAAABAA8ADwA0AUABdwAKAZcALQHOAAQB/gAyAncAIwL9ACkDNQAnA3ACMP////8AEQANADUBPgF3AA0BlgAxAf" +
  "8ALwJxACcC+wArAzIAKgNiAAgDcQIu/////wAWAAgAOgAHAEIABQBKASgBdgATAZYADwGmACQB/wAvAnYAIAL6ACwDLwAtA2MCNP////8ATAEj" +
  "AXYAFAGqACIB/wAvAncAGwL4ACwDLQAzA2QCNf////8ATAEcAXUADgGEAAsBrQAfAgAALQJ2ABcC9QAtAyoCcP////8AIAAIAEsBGwFzAAQBeA" +
  "AIAYcACAGwAB0CAQArAoEABwLzACwDKAJz/////wAmAAgARQEhAXkABAGwABABwgAMAgMAJwLwAC0DJgJ2/////wA9ASgBswAPAcYABwIFACMC" +
  "7AAuAyUCef////8APAEkAYEABwG3AA4CBgAfAugAMAMkAnr/////ADoBJAGAAAYBkAADAZcACQGnAAMBvAALAggAHgLmADEDJAI5BWEAMgWbAA" +
  "P/////ADgBJAGOAAUBlwAWAcQABAIJAB4C5AAyAyUCNwVgAC//////ADgBIwGPAAMBmAAYAgoAHALkADIDJgImBU0ADgVfACr/////ADgBIQGY" +
  "ABoCCwAbAuQAMQMlAh4FTgALBV8AJv////8AOgA6AHYA4gGYAB8CDQAYAuQAMgMlAhwFTwAHBV4AJP////8AOgA3AHMADwCEANMBmAAiAhcADQ" +
  "LkADMDJQIaBU8ABAVbACX/////ADsANQBxAA8AiADPAZkAIQIZAAsC5AA1AygAFgNAAf4FWAAbBXQACf////8AMgAIAD4AMQBxAA8AjQDJAZoA" +
  "IAHMAAMCGwAIAuQANwMqAAoDQwH5BVYAGQV3AAT/////ADUABABAAAIARgAmAHAADQCaALwBmgAgAcoABgLlADYDQgH4BVQAEQVoAAL/////AE" +
  "gAIgBwAAgAoAC2AZkAIgHJAAgC5QA1AzQABgNAAeYFLAAPBVIADP////8ARwAiAHEAAgCjALMBlwAkAcgACgLlABMC+gAfAy0B5AUeAAUFLQAP" +
  "BVAADf////8ARwAGAE8AHAClALIBlgAnAccADALmABAC+wAcAy0B2wUtAAgFTgAO/////wBQAAEAUgADAFoAEACoALQBlwApAcUAEAK7AAMCwQ" +
  "ADAuYADgL8ABgDLQHZBUwADv////8AWQAPAKwAsQGZAD0CugAJAukACAL9ABYDMAHUBUoAD/////8AWQANAGsAAQC4AKUBmwA8ArkACQL+ABUD" +
  "MQHRBUcAEv////8AWQAJAGcACQC4AKYBnAA8ArgACQLCAAcC+QACAv4AFQMpAAIDMQHPBUMAGf////8AVwAIAGUACQC5AKYBnQA9ArgAEAL2AA" +
  "UC/wAUAyYABgMwAc4FQgAb/////wBVAAkAZQAHALoArwGdAD4CtwARAvEACQMAABIDJQAJAzABzAVBABz/////AFIACQC8ALIBnQA9ArcAEALw" +
  "AAoDAQARAyQB1gU/AB7/////AE8ACQC+ALMBnQA8ArgADgLwAAwDAgAPAyQB1AU/AB7/////AE4ACQC/ALQBnABAArkADALwAAsDAQAKAyQB0g" +
  "U+ABv/////AEcADQC/ALgBmwBEArkAEALwAAgC+wAPAyQB0AU+ABr/////AEUACADAALsBmQBIArkAAgK8AA0C8AAHAvwADQMkAc4FPQAb////" +
  "/wBCAAcAwwDEAZcATAKzAAMCuwAPAvEABwL9AAUDJAHMBT0AG/////8APgAIAMUAwgGTAFYCrwAJArwADwLyAAYDAAABAxYAAQMfAc8FPgAb//" +
  "///wA8AAQAxQDCAZEAWgKtAA0CwQANAvIABwMRAAoDHgHWBT4AF/////8AxgDBAZMAWQKrAA4CwwAMAvIACgMAAAUDDQHoBPsAAwUIAAMFPgAU" +
  "/////wC7AAYAyAC/AZMAWgKpAA8CxAAMAvIAFgMJAe4E+QAJBQkAAwU/ABL/////ALsABgDKAL4BlABcAqkADwLDAA4C7AIXBQkAAwU/ABL///" +
  "//ALwABQDLAL0BlABdAqoADgK9ABQC5QIgBQYABwU/ABL/////AL4AAgDLAL4BlQBdAqsADQK9ABUC4gIrBUAAC/////8AvwADAMwAvgGVAF0C" +
  "qgANAr0AGgLhAi0FQAAK/////wDAAAMA0AC6AZUAXQKpAA0CvgAZAuECLQVAAAr/////ANAAvAGUAF0CqAALArsAGwLgAiUFBgAHBUEACf////" +
  "8A0AC+AZMAWwKrAAQCuwAaAt8CJQUGAAgFQQAH/////wDQAMABkgBaAe4ABALCABQC3QImBQcABwVCAAT/////ANEBFQHsAAUCvgAXAtkCKgUI" +
  "AAcFQgAC/////wDTAREB6gAGArwAFwLWAi0FCAAH/////wDOAAcA2AEKAekABgK6AAkC1QIuBQgACP////8AzwALANsA7AHWAAcB6QAFArgABQ" +
  "LVAi4FCAAI/////wDTAAgA3QDoAc4ABAHoAAoC0QIxBQgACf////8A1AAJAN8A5QHQAAcB5wALAfUAAgLIAAMCzgI0BQgACv////8A1wAIAOIA" +
  "3gHKAAIB1AAFAeYAFQLIAjoFCAAFBQ4ABf////8A2QAIAOQA2gHDAAwB5QAVAskCOAUHAAb/////ANwABgDlANcBwAAPAeMAFgH6AAICvQJEBQ" +
  "cABf////8A3QADAOUA1gG9ABAB5AAZAr0CQwUHAAT/////AN0ABwDmANQBuwARAeIAGwK+AkEFBwAE/////wDeAAcA5gDSAboAEwHiABwCwgI7" +
  "BQgABP////8A3gDZAbgAFQHyAAMB9wAHAsUCNwUHAAb/////AN8A1gG3ABYBzwABAfAABAH3AAYCxwCgA2wBjwUHAAf/////AN8A8gHcAAMB+A" +
  "AEAsgAnANnADMDpAFWBQcACP////8A3wDvAc8ACQHbAAQCyQCCA04AEANnAC4DpAFWBQcAAwUMAAP/////AOAA8AHTAAQB2gAGAsoAgANUAAgD" +
  "aAAsA6QBVAUIAAH/////AOAA8wHVAAsCywB+A1UACANnACsDpAFT/////wDgAP4CywA4AwYAQgNSAAwDYgABA2UAKgOkAVEFBwAC/////wDgAO" +
  "UBzQAOAsoAOAMGAAMDCgA9A1QADgNjACoDnQFXBQcAA/////8A4ADlAcoADALKADgDBwABAwsAOgNVAAgDZQAnA50BVgUGAAb/////AN8A4wHH" +
  "AAsCygA4AwwANwNVAAUDZwAlA5kBWAUGAAf/////AN8A4AHHAAgCygAoAvUADgMMADcDawAiA5kBVwUGAAoFFAAC/////wDfANwBxwAGAsoAJw" +
  "L4AAwDDgA1A2wAIgObAVMFBQAR/////wDfANkByAADAq4ABwLIACYC+QAOAw8AMwNuACEDnAFRBQUAEf////8A3gDZAqwANQLlAAcC+QAOAxIA" +
  "LwNwAB8DnQFOBQEAFv////8A3gDYAqoAMwL1AAEC+gAOAxUAKwNzABwDnwFABOIABgUAABH/////AN4A1wKrADIC8wADAvsADgMYACcDdQAbA6" +
  "IBOwT/ABH/////AN4A1wKrADEC8gAFAvwADwMaACYDdgAbA6IBOgT/AAcFCQAF/////wDfANcBtwABAqsAMgLyAAUC/gAPAxwAJANZAAQDdgAc" +
  "A6EABQOnATIE/wAHBQwAAf////8A3wDaAqsAMQLyAAQDAAARAx4AIwNRAA8DdgAdA6IAAgOnATEE/wAG/////wDfANQCrAAuAvQAAQMCAA8DHQ" +
  "AmA04AFQN1AB8DogACA6gBL/////8A3wDNAa4AAgKsACoC9AACAwYADgMdAEsDbQACA3IAIwOqAS0FAAAG/////wDeANACrAAnAvAABwMIAA8D" +
  "HQAUAzgABgNDAFMDowADA6kBDAS3AB8FAAAH/////wDeAMoCrAAmAvEABwMLAA4DHQATAzgABANDAFYDowEQBLgAHAT/AAj/////AN8AyQKsAC" +
  "UC8QAHAwwABwMXAAMDHgANAywABgM5AAEDOwBcA6IBDwS3ABsE/wAJ/////wDgAMgCqwAlAvEABgMOAAQDGQABAx8ADQM6AFwDpQEKBLUACwTB" +
  "AA4E/wAJ/////wDgAMcCqgAmAvEABgMOAAYDIAAMAzgAXgOkAQoEtQAGBMUACgUAAAj/////AOAAxgKqACYC8QAGAw8ABgMhAA0DOQBdA6UBBQ" +
  "S1AAQExQAJBP8ACf////8A4QDDAqkAJwMQAAUDIgALAzsAWQOnAQAEtAABBMQADAT/AAj/////AOIAwgKqACYDDwADAyMACwM6AFoDpwEABMQA" +
  "DgT+AAj/////AOMAwQKsACMDDgAEAyQADAM5AFsDpwEBBMMAEAT9AAj/////AOQAuwGgAAMCrAAiAwIADwMkAA0DOgBbA6YBBQTDABEE/AAI//" +
  "///wDlALoBoAACAq0AIQMBAA0DJQAJAzAAAQM8AFkDpwEFBLEABQTIAA0E+gAK/////wDmALkBoAABAqwAHgL1AAIDBAAJAyUACAM8AF0DpwEG" +
  "BK8ACwTJAAwE+AAM/////wDnALgCrAAGArMAFgLoAAYC8gAHAvsAAgMIAAYDJgAGAz0AXgOnARMEywALBPIAAwT2AA7/////AOcAugK2ABIC2g" +
  "AiAwsAAgMnAAYDPgF4BMgADgTxABP/////AOgAuQK2AAcC0wAoA0QABgNQAAkDXwFVBMkADQTwABP/////AOkAuAK4AAQC0AArA18BVATJAA0E" +
  "8AAT/////wDqALcCzAAwA2ABUATKAAwE7wAU/////wDrALYCtwAGAskAMwMuAAMDVwADA18BUATKAAwE4wAf/////wDtALMCtwBFAzEACANTAA" +
  "UDXwFPBMkADAThACH/////AO0AsgK2AEYDUQAGA18BTwTJAAgE3wAf/////wDtAK4CtQBFA18BUQTJAAUE3QAOBOwACf////8A8gCoArQARQNe" +
  "AVQE2wAJBOcAAwTsAAf/////APYAogKyAEgDXQFVBNoABwTjAAgE7AAG/////wD4AJ0CsABMA10BVgTZAAUE4QAKBO4AAv////8A+QCbAq0AUA" +
  "NcAVcE1QALBOEABQToAAL/////APoAmAKsAFUDXAFYBNYACgThAAT/////APsAlQKrAF4DIwAJA1sBWgTXAAn/////APsAlAKqAGMDIQAMA1sB" +
  "WwTZAAb/////APwAkQKqAGQDIAAQA1oBXQTZAAb/////APwAkAKpAGYDHwAWA1oBXgTZAAX/////AP0ACAEJAIICqQBmAx8AHgNHAAgDWQFfBN" +
  "gABv////8A/gAHAQsAgAKoAGwDIAAhA0UADwNYAWAE2gAC/////wD/AAYBCwCAAqkAbwMfAZj/////AP8ABwELAIACqQByAx0Bmf////8BAAAG" +
  "AQwAXgF4ABMCqQIN/////wEBAAYBDQBeAXoABAGBAAsCqQDoA5kBIP////8BAgAGAQ4ASAFiAAkBggAKAqgA6QOZASD/////AQQABQEOAEYBZA" +
  "AHAYMACgKmAOsDmgEe/////wEFAAYBDwBEAYQACQKkAO4DmwEd/////wEHAAUBEABBAYUACQKjALcDWwA3A5wBHP////8BBwAGAREAPQGFAAkC" +
  "oQCzA1UAPgOcARv/////AQYABwETADoBhAAKAp0AuANWAAMDXAA3A50BGP////8BBAAKARUANwGEAAsCmwC7A1cAAQNdADcDoAEU/////wEFAA" +
  "oBFgA1AYUACwKaAL0DXgA4A6MBEP////8BBwAJARcANAGGAAoBmAABApkAvgNfADgDpAANA7MA//////8BCQAJARgAMwGHAAkBlAAIApkAvwNg" +
  "ADkDpwAGA7QA/f////8BDAAGARoAMQGHAAkBmgACApcAwQNhADgDtAD8/////wEOAAUBGgAxAYgACAGaAAIClQDEA2EAOAOcAAIDsAACA7UA+/" +
  "////8BDwAEARoAMgGJAAcClQDFA2IANwObAAQDrwADA7UA+v////8BDwAFARsAMAGKAAUClADHA2QAOwOtAAUDvADy/////wEPAAYBHgAtAYwA" +
  "AwGXAAIClADHA2QAOwOsAAYDxAAGA9oA0wS1AAL/////AQ8ABwEfACsBlgADApQAyANkADoDqgAIA9sA0QS0AAT/////ARAABgEgACoBlgAEAp" +
  "MAygNlADkDqQAKA9wAzwSyAAb/////ARIABgEiACgBlwADApEAzQNmADoDqAAMA90AzASyAAX/////ARQABQEjACcBmAACApAAzwNoAE4D3gDJ" +
  "BLEABv////8BFgAEASQAJgKPANADagBRA+EAxASwAAb/////ARcABAEmACMCjwDQA2oAUgPiAMEEsAAG/////wEXAAMBJwAiAYIADgKOANEDaw" +
  "BSA+QAvQSwAAX/////ASgAIQF/AAYBhwALAo4A0wNsAFID5QBWBD0AXgSxAAT/////ASkAIAF+AAUBhwARAo4A1QNsAFQD5gBVBD4AWQSYAAIE" +
  "sgAC/////wBRAAIBKQAhAX0ABAGNAA0CjADYA2wAUwPkAFYEPwBWBLIAAv////8BKgAgAZAADAKMANgDbABSA+YATgRAAFL/////AFcAAwEqAC" +
  "EBbAAJAZUACAKLANoDbABRA+cARQRAAEAEhwAF/////wBaAAMBKgAhAWcADgGVAAwCiwDaA20ATwPoAAgD8gA7BEAAPgSGAAX/////AF0AAwEq" +
  "ACIBZgAPAZcACwKMANgDbQBOA+wAAQPyADsEQQA7BIYABf////8BKQAjAWYADgGbAAsCjgDXA24ATQPzADkEQgA5BIcAA/////8AYAACASkAJA" +
  "FlAA4BmgAOAo4A1wNxAEcD8wA4BEMANv////8AYAAEASoAJAFlAA0BqwAEAbEABQKOANcDcgBFA/MANQREADQEhAAI/////wBgAAUBKwAkAWUA" +
  "DgGsAA0CjgDXA3MARAPzADIERgAyBIMACf////8AYAADASwAJAFkAA4BrAAQAo4A2AN0AEQD8wAxBEYAMQSCAAn/////AS8AIgFiABABrQARAo" +
  "8A1wN0AEED8wAwBEcAMQSCAAj/////ATAAJQFeABQBpgADAa4AEQKPANgDdQA+A/MALgRIADAEggAH/////wEyACQBWAAZAZYACAGmAA4BtQAD" +
  "AbwAAgHDAAcCjwDZA3UAPgP0ACwESQAwBIUAAgSyAAj/////ATYAOgGYAAgBsQADAcMAAgKPANsDdgA8A/QAKwRJADEEsgAH/////wE5ADYBsg" +
  "ABAo8A3AN4ADYD9AApBEkAMgSxAAj/////ATsANQKPANwDeQA1A/QAJwRKADIEsQAJ/////wE+ADICjgDeA3kAMwP1ACQESQA0BLEACf////8B" +
  "QQAuAo0A4AN6AC0D9QAkBEkACwRVACkEsQAJ/////wFFACoCjQDgA3sAJwP1ACMESQAJBFUAKwSxAAn/////AUgACwFWABcCjgDfA3sAJwP2AB" +
  "8ESAAIBFYAKwSvAAn/////AUwABQFZABsBdgAJAo0A4QN6ACcD9gAcBEsAAwRWACwErwAI/////wFbACYCjADkA3sAJQP3ABoEVgAtBK8ACP//" +
  "//8BXAAnAosA5gN6ACMD+AAZBFYALgSwAAf/////AV0AJwKKAOkDewAeA/kAGARXAC0EsAAH/////wFfACUCigDrA3sAGwP5ABgEVwAuBLEABv" +
  "////8BYAAkAosA6wN8ABgD+gAXBFcALgSyAAr/////AWUAHgKMAOsDfAAUA/oAFwRYAC0EsgAN/////wFoABoCjQDsA3wAEgP6ABcEWAAuBLgA" +
  "CP////8BbAAFAXIAEAKMAO4DfAALA/sAFwRZAAgEYwAjBLEABQS6AAEEvAAE/////wFxABECjADvA30ACAP7ABcEWQAIBGMAIwSyAAQEvQAE//" +
  "///wFyABECjQD1A/sAFgRZAAgEYwAjBLMAAwS/AAL/////AXMADwGwAAMCjQDxA/wAFARZAAgEaQAdBLQAAgTBAAX/////AXUADQGvAAUBtwAC" +
  "Ao4A8AP9ABMEWQAHBGoAGwTCAAX/////AXYADAGtAAYBtgAEAo8A7AOZAAQD/QATBFoABgRrABoEtwACBMMABP////8BdwAKAasABgG3AAYCkQ" +
  "DsA5MACgP+ABIEWwAEBGsAGQS4AAUEwQAG/////wF5AAgBpQANAbMADAKTAOwDjQAQA/8AEQRaAAUEbAAWBK0AAgS3AAYEvwAGBMYAAv////8B" +
  "eQAJAaIAHgHZAAQClADsA4kAFAP/ABEEWQAFBG0AEwSsAAMEtwAKBMMAAv////8BeAALAaEAKAHOAAgB2QAEApUA7AOCABoEAAAQBFkABQRxAA" +
  "0ErAADBLgAAQS7AAYEwwAC/////wF4AAwBoQAQAbIAGQHNAAkB2AAFApUBBwQAAA0EWgADBHMACgSrAAIEugAGBMMAAf////8BegALAaEADwGz" +
  "ACcClwEEBAEADARaAAMEdAAHBKoAAgS5AAb/////AX4ACAGRAAMBoQAQAbMAKQKZAQIEAQALBBAAAwRZAAQEcwAHBKgAAwS6AAQExQAD/////w" +
  "GAAAgBjwAJAZ8AEgGzACoCmgEBBAEADAQPAAUEWQAGBHMABQSnAAMEuwACBMUABP////8BgQAJAYwABgGUAAYBnQBBApsA/wQCAAgEDwAGBFgA" +
  "CQRzAAQEpgACBMIACP////8BgQAQAZUASwKbAP8EAwAGBA8ABwRYAAkEpQABBL0AAgTCAAj/////AYMAAgGGAAkBlwBLApsA/gQEAAQEDgAIBF" +
  "gACgS7AA//////AYkABgGWAE4CmwD+BAYAAQQOAAkEWQABBFsABwS5ABH/////AYsABQGWAE8CnAD8BA8ACARcAAYEuAAGBL8AC/////8BjAAD" +
  "AZcAUAKdAPoEDwAJBF4ABQS3AAQEwAAL/////wGZAE4CnwD4BA8ACAReAAYEuAACBMAACv////8BmgBPAqIA9AQPAAgEXwAIBKIABATAAAYEyA" +
  "AC/////wGaAFACowDyBBAABwRgAAgEoQAGBMAABwTIAAH/////AZoAUQKlADIC4gCzBBEAAwRhAAkEoAAHBMEABv////8BmgBeAqcALALjALEE" +
  "YQAKBJ8ACgTDAAT/////AZkAYwKoACgC5ACvBE0AAQRgAAwEnQAQ/////wGaAGQCqgAUAsAADQLkAK4ETQAKBGEADASbABL/////AZoAZgKrAA" +
  "0CxgAEAuUArAROAAoEYgAMBJoAEP////8BmgBnAq4ABwLmAAoC8QCfBE8ACgRiAAwEmAAT/////wGaAGgC8wCcBFAACgRiAAwElwAS/////wGb" +
  "AGkC8wCbBFEACwRiAAwElgAR/////wGaAGoC9QCYBFMACgRjAAsElQAS/////wGZAGwC9gCWBFQACwRlAAkElAAS/////wGZAGwC9wCUBFUACw" +
  "RlAAkEkQAW/////wGXAG4C9gCUBFYACwRmAAkEjQAb/////wGVAHEC9gCSBFcACwRoAAgEjQAc/////wGVAHEC9gCRBFkADgRpAAgEjAAcBM8A" +
  "Af////8BlAB1AvUAkARaAA8EawAGBIUAJATOAAL/////AZQAdQL1AI4EWwAPBG0ABASEACYEwgADBM0ABv////8BkgB3AvUAjARbABAEhAAoBL" +
  "IABATBAAMEzQAG/////wGPAHkC9QCKBFwAEASDACUEsQASBM0ABv////8BjwB4AvUAiQRcABEEgwAkBK8AEwTOAAX/////AY8AdwL1AIgEXQAT" +
  "BIMAJASvAAIEzgAD/////wGOAHwC9ACHBF4AEQSEACIErgADBM4AAv////8BjgCAAvQAhgRfABAEhAAjBK4AAwTPAAIE4AAE/////wGNAIECDw" +
  "AFAvMAhgRgAA8EhQAiBK4ABAS5AAUE0AACBN0AC/////8BjACMAvMAhQRhABEEhQAgBK0ABgS1AAYE2gAP/////wGMAI8C8wCFBGIAEASGAB0E" +
  "rQANBNsADv////8BjACRAvQAgwRiABEEiAAbBK0ACwTfAAoE9QAF/////wGMAJIC9QB/BGMAEASIABsErAALBOAACgTzAAr/////AYwAkwL2AH" +
  "0EZAAQBIgAGwSsAAwE5gAEBPEAD/////8BjgABAZAAlwL3AHoEZQATBIgAGgSrAA4E4QAJBPAAFQUrAAL/////AZAAoQL4AHkEZgATBIkAGQSr" +
  "AAcEswAHBNAACATgAAwE7wAZBSwABP////8BjwClAvkAeARnABIEjwAEBJYADASrAAcEswAHBMgABQTPAAwE4gApBS4ABP////8BjQCpAvoAdg" +
  "RoABEEmgAIBK4ABASzAAcEyAAFBNkAAgTjACwFMAAD/////wGMAKsC/ABzBGkADwSaAAQEoAABBK4ABAS1AAYE4wADBOkAKgUxAAP/////AYsA" +
  "rgL9AHIEagAOBK4ABAS2AAYE6wAqBS4AAwUyAAP/////AYoAsAL+AHAEbAAMBK4ABAS2AAcE7wAnBS4ABAUzAAL/////AYoAsgL/AG4EbgAKBK" +
  "4ABAS2AAIEuQAEBPIAJgUuAAT/////AYsAtwL/AG4EbwAJBK0ABQS5AAQE9QAjBScAAgUsAAUFOgAB/////wGLALkDAABsBHEABwStAAUEuQAD" +
  "BOkAAgT3ACEFIQACBScAAgUqAAYFOgAC/////wGMALgDAABsBHIABgTpAAIE+AAkBSEADQU6AAP/////AYsAuQMBAGsEdwAIBOgAAwT5ACYFJA" +
  "AHBTsAA/////8BjAC5AwEAawR2AAwE6AADBPkAJwU8AAT/////AY4AtwMCAGsEdQAOBIoABQToAAIE+gAiBT0AAwVCAAH/////AZAAtQMDAGsE" +
  "eQAaBPoAIwVDAAL/////AZEAtQMDAGsEeQAbBPoAIwVEAAMFSQAB/////wGRALQDAwBqBH8AFwT4ACcFSQAD/////wGSALMDBABpBIgAFAT3AB" +
  "kFFwAJBUsABP////8BkwCyAwQAaQSNABIEpwACBKsAAQSyAAIEuQADBMsAAQT2AAYFAAAOBRgACQVNAAP/////AZQAsAMEAGkEmAAFBKQACQSv" +
  "AA0ExQAIBQEADQUZAAkFUgAD/////wGUALADAwBrBKMABQSzAAMEwwAHBQMACwUaAAkFUwAC/////wGVAK4DAwBsBMAABwUJAAMFGwALBVQAAv" +
  "////8BlgCsAwQAawSsAAUEvwAFBRwACgVOAAUFVQAC/////wGWAKsDBABsBK4ABQS+AAUFHgAKBVAABP////8BlwCpAwUAbASwAAMEvQAFBSAA" +
  "Cv////8BlwCoAwUAbQUnAAQFVQAE/////wGYAKUDBgBsBQkAAgVWAAT/////AZkAowMGAGwFCAAE/////wGZAKIDBgBsBOAABQUIAAT/////AZ" +
  "oAoQMGAGwE4gAEBQcABf////8BmwCfAwYAbATiAAoE7gAFBQcABv////8BmwCeAwUAbgOTAAME2wAZBQYAB/////8BnACcAwQAbwOTAAQE2gAa" +
  "BQcAB/////8BnQCaAwMAcAOTAAUE2QAaBQYACf////8BngCXAwIAcQOSAAYE2QAZBQYACf////8BngCXAwEAcgORAAgE1wAaBQYACf////8Bng" +
  "CXAwEAcgOPAAoEygADBNYAGgUGAAn/////AZ8AlgMBAHIDjwAKBMgABwTWABoFBgAKBREAAv////8BnwCWAwAAcwOOAAsExgALBNUAGgUGAA7/" +
  "////AaAAlQMAAHMDjQANBMQADgTWABgFBgAPBWoAAv////8BogCTAwAAcwOLAA8EwwAsBQYAEAVqAAP/////AaQAkQL/AHMDigAQBMEAMAUGAB" +
  "AFagAD/////wGmAI8C/wBzA4kADgOYAAIEwQAzBQUAEf////8AAAABAagAjQL+AHMDhAAUBMEANQUFABEFbAACBZ8AAf////8AAAABAaoAigL+" +
  "AHIDgQAXBLwAAQS+ADoFBQASBW0AAwWdAAP/////Aa0AhwL+AHADgQAXBLsAAgS+ADsFBAATBZoABf////8BrwCFAv4AbQOAABcEuQAFBL8APg" +
  "UDABX/////AbEAgwL+AGoDgAAWBLkARAUDABYFmQAB/////wGyAIIC/wBnA38AFwS5AGAFlQAG/////wGzAIAC/wBmA4AAFgS5AGAFlQAG////" +
  "/wG2AHwC/wBkA4AAFgS4AGEFlwAB/////wG2AHwDAABiA4AAFQS3AGL/////AbYAfAMBAF8DgAAVBLYAZP////8BtwB7AwIAXQOBABQEtQBn//" +
  "///wG3AHoDAwBaA4EAEwS0AGv/////AbcAegMDAFkDgQATBLEAcP////8BtwB5AwQAVwOBABIEqwB3BWAAA/////8BtwB4AwQAVwOAABMEqAB8" +
  "BWAABf////8BtwB3AwUAVwN/ABMEogCCBWEABf////8BtwB2AwUAWAN/ABMEnwCGBWMABf////8BtwB2AwYAVwN9ABUEngCIBWQABf////8Btw" +
  "B2AwcAVwN9ABQEmwCLBWYABf////8BtwB1AwgAVgN9ABQElwACBJoAjQVoAAT/////AbcAcwMJAFYDfQATBJcAkwVqAAL/////AbYAcwMJAFYD" +
  "fQATBJcAlf////8BtgBuAiUABAMJAFYDfQATBJcAlf////8BtgBpAwkAVQN+ABEElwCV/////wG2AGYDCQBVA34AEQSWAJf/////AbYAYwMJAF" +
  "YDfgAQBJUAmf////8BtgBgAwkAVQN+ABAElQCb/////wG1AF8DCgBSA38ADwSWAJv/////AbUAXQMKAE8DfwAOBJYAnP////8BtQBcAwoATAOB" +
  "AAkElwCc/////wG1AFsDCwBJA4QAAwSYAJz/////AbUAWgMLAEgElQACBJgAnf////8BtABaAwsASASWAJ//////AbQAWgMMAEgElQCg/////w" +
  "G0AFoDDABIBJYAn/////8BtABaAwwARwSXAJ7/////AbQAWgMNAEYEmACd/////wG0AFoDDgBFBJgAnv////8BswBbAw4ARQSYAJ7/////AbMA" +
  "WwMQAEIEmQCe/////wGyAFsDEQBBBJoAnf////8BsgBaAxIAPgSaAJ3/////AbIAWAMSAD0EmwCb/////wGyAFcDEwA6BJwAmv////8BsgBXAx" +
  "QAOAScAJn/////AbIAVgMUADgEnACZ/////wGxAFYDFQA2BJwAmf////8BsQBVAxYANASdAJj/////AbEAVAMXADIEnQCY/////wGxAFMDGAAw" +
  "BJ4Alv////8BsQBRAxgALgSeADcE3wBV/////wGyAE8DGAAtBJ8AMQTkAE//////AbIATQMYACsEnwApBOYATf////8BsQBOAxcAKwSeACcE6A" +
  "BK/////wGxAE0DGAAoBJ4AIwTpAEf/////AbEATAMZACUEngAjBOoADAT3ADj/////AbAATAMYACIEnAAkBOsACgT3ADf/////AbAASwMZABED" +
  "KwACAzAABAM2AAIEnAAXBLYABwTsAAcE9gA4/////wGwAEoDGgANBJwAEwTsAAYE9QA4/////wGvADgB7AAMAx0ABgSfAA0E7QAEBPUANwWCAA" +
  "P/////Aa4AOwHvAAEB8gAEBKEACQTvAAIE9AAEBPkAMwWDAAP/////Aa4APQTzAAME+QAyBYQABf////8BrQA+BPgAMgWFAAX/////Aa0APgT8" +
  "AC4FhgAE/////wGsAEAE/gArBYcABP////8BrABCBP4AKwWIAAT/////AasAQgT/ACoFiQADBY0AAv////8BqwBCBP8AKQWJAAf/////AakAQw" +
  "T/ACkFigAG/////wGpAEIFAQAmBYoABwWXAAP/////AakAQQUCAB4FigAQ/////wGpAD8FBgALBRMACwWKABD/////AaoAOwULAAUFFQAHBYoA" +
  "EP////8BqgAtAdoAAgUYAAMFiQAQ/////wGrAC0FhwAO/////wGqAC4FhwAN/////wGpAC8FigAL/////wGpAC4FjAAI/////wGoADAFjAAH//" +
  "///wGoAC8FEgAEBYEAAwWMAAb/////AagAJAHQAAQFEgAHBRoACAWAAAUFhgADBYsABv////8BqAAkBRMADwV/AAoFjAAE/////wGnACUFFAAO" +
  "BX4AC/////8BpwAmBRUADQV9AAz/////AacABAGsACYFFQAMBXwADP////8BpwADAawAJgUVAAsFewAM/////wGmAAQBrAAiBRYACgV6AAv///" +
  "//AacAAwGsACEFFwAGBXgADP////8BqwAhBRoAAgV2AA7/////AasAIQV0AA3/////AaYAAwGrACAFcAAP/////wGmACUFbwAP/////wGlACYF" +
  "bQAQ/////wGlACEFbAAR/////wGlAB8FawAR/////wGlAB4FagAR/////wGjAB8FagAQ/////wGiACEFbwAI/////wGiACL/////AaYAIP////" +
  "8BpQAl/////wGjACb/////AaIAJ/////8BogAl/////wGhACT/////AaEAIgPjAAT/////AaEAIgPiAAn/////AaEAIQPiAAj/////AaEAIP//" +
  "//8BogAd/////wGiABv/////AaMAGf////8BowAZ/////wGjABoB3gAK/////wGjABoB3AAN/////wGjABsB3AAEAeEABf////8BpAAWAb8AAf" +
  "////8BpwARAbkABf////8BpQADAaoACwG2AAn/////AacABAGsAAkBtgAK/////wGpABj/////AaoACAG0AA7/////AawAGf////8BrwAa////" +
  "/wGyABr/////AbYADgHFAAb/////AboAB/////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////8B6AAB/////wHkAAf/////AeEACP////8B2wAL/////wHYAAP/////" +
  "AdIABv////8BzwAH/////wHOAAgE7AAC/////wHLAAsEaQAGBOsABf////8ByAAPA6EAEgRnAAsEkwAHBOsABf////8BxgAQA50AGAQvAAMEZQ" +
  "AQBIwAEATdABT/////AcQADAObABsELgAFBGIAFQSIABwEtwAbBNQAH/////8BwgAMA5gAIQQsAAkEYABIBLUAY/////8BwQALA5EALQQYADcE" +
  "UADJ/////wHBAAkDiQADA44ANQPOAAgEFQEE/////wHBAAkDhABDA8oAGgQSAQr/////AcIACQOAAGUEDQEV/////wHBAAwDVgAEA3gAbgQKAS" +
  "AFOAAC/////wG2AAIBwAARA1QACQN0AHMECQE1/////wGyAAcBvgAWA1MADgNiAAQDbwB4BAcBOv////8BsQAJAb4AFwNRABcDbgB5BAQBR///" +
  "//8BsQAKAb0AGQNKAJoD+AFW/////wGxAAwBvgAZAu0ACgMCAAoDDgAZA0UAnAP2AVz/////AbEADAG/ABkC6AARAwAAKQM6AKYD9QFh/////w" +
  "GwAA4BwAAZAuEAGgL8AOkD8wF4/////wGvABABwQAZArMABwLYAQwD8QGD/////wGmABkBwgAZAqUACAKyAAkCwAAPAtIBEAPvAYz/////ATkA" +
  "AQGjABwBwwAYAqMBPgPuAY//////ATcAEQFJAAUBpAAaAcMAGAKhAUED7AGR/////wE5ABYBpwABAa8ACQHCABoCnwLc/////wExAAIBagACAc" +
  "EAGwKbAt//////ATEAFAFpAAYBvAAhApUC5P////8A1QACATIAFgFZAAgBZwATAY4AAwGwAC4CkQLm/////wDVAAcA5QAKAPIAAwEzABoBTwA1" +
  "AYwAEAGpADQCjwLn/////wDoAAoBBQAFATQAawGiADoCjgLi/////wD0ABgBOwCfApIC2/////8ArgBgAREABAE8AJkCkALY/////wCnAHQBPw" +
  "CTAowC2/////8AmACKASQAFQE+AJICiQLb/////wCGAAkAkAE8AoMC3v////8AhgE+An0C4/////8AhwE2AnYC6f////8AhwExAmUC+v////8A" +
  "fwEdAlwDAv////8AVgAEAHoBIwJZAwX/////AFcAFQB0ATACVAMM/////wBXAVECTwMS/////wBXAVICEQAJAkYDHP////8AQwAEAFoBQQILAB" +
  "QCQQMo/////wBBAA0AXgE7AgkAGAJAAyz/////AEMADgBhATgCBwAbAkADJf////8ARQAOAG0BLAIGAB0CQAMX/////wBJAAkAfQEgAgQAHwJZ" +
  "Avz/////AIMBGwHcAAQCAQAiAloC+v////8AhQEdAdoACAH6ACcCXAL4/////wCFASgByAAZAfcAIwJaAvj/////AIEBMwHLABUB+QAXAk4DA/" +
  "////8AagAIAHsBQAI/AxP/////AGIBYwIrAyv/////AGUBbQIOAAYCJgMx/////wBsAW4CAAAkAiUDNf////8AbQF0AfcDaP////8AbAF4AfAD" +
  "dP////8AawF7AeoDgP////8AagUI/////wBpBQz/////ACYAAwB0BQb/////AAMAAwAOAAUAGgAUAHcFDAWNAAX/////AAEAMwCEBRf/////AA" +
  "AAQACTBQ3/////AAAASgBgAAkAjgUS/////wAAAHoAggUe/////wAABaD/////AAAFoP////8AAAWg/////wAABaD/////AAAFoP////8AAAWg" +
  "/////wAABaD/////AAAFoP////8AAAWg/////wAABaD/////AAAFoP////8AAAWg/////wAABaD/////AAAFoP////8="

let landBits: Uint8Array | null = null
const bits = (): Uint8Array => {
  if (landBits === null) {
    const bin = atob(LAND_SPANS_B64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const out = new Uint8Array(Math.ceil((LAND_W * LAND_H) / 8))
    let i = 0
    for (let row = 0; row < LAND_H; row++) {
      for (;;) {
        const start = (bytes[i]! << 8) | bytes[i + 1]!
        const len = (bytes[i + 2]! << 8) | bytes[i + 3]!
        i += 4
        if (start === 0xffff) break
        for (let c = start; c < start + len; c++) {
          const idx = row * LAND_W + c
          out[idx >> 3] = out[idx >> 3]! | (1 << (7 - (idx & 7)))
        }
      }
    }
    landBits = out
  }
  return landBits
}

export const landAt = (lon: number, lat: number): boolean => {
  const x = Math.min(LAND_W - 1, Math.max(0, Math.floor(((lon + 180) / 360) * LAND_W)))
  const y = Math.min(LAND_H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * LAND_H)))
  const idx = y * LAND_W + x
  return (bits()[idx >> 3]! & (1 << (7 - (idx & 7)))) !== 0
}

export interface GlobePoint {
  readonly vec: Vec3
  readonly lon: number
  readonly lat: number
}

/** Land points on the sphere, near-even density, deterministic.
 * Step 1.2° ≈ double the density of the 1.7° sampling again
 * (Kimler, 2026-10-13) — about 7,800 land points. */
export const buildGlobePoints = (stepDeg = 1.2): ReadonlyArray<GlobePoint> => {
  const pts: Array<GlobePoint> = []
  let row = 0
  for (let lat = -57; lat <= 84; lat += stepDeg, row++) {
    const phi = (lat * Math.PI) / 180
    const lonStep = stepDeg / Math.max(0.35, Math.cos(phi))
    const offset = row % 2 === 0 ? 0 : lonStep / 2
    for (let lon = -180 + offset; lon < 180; lon += lonStep) {
      if (!landAt(lon, lat)) continue
      const lam = (lon * Math.PI) / 180
      pts.push({
        vec: {
          x: Math.cos(phi) * Math.sin(lam),
          y: Math.sin(phi),
          z: -Math.cos(phi) * Math.cos(lam),
        },
        lon,
        lat,
      })
    }
  }
  return pts
}

/** The user's home (Tucson, AZ) — the field's one fixed star. */
export const HOME = { lon: -110.9, lat: 32.2 } as const

// ── World events (2026-10-13) ─────────────────────────────────────
// The widget's events ride the hook's hidden .globenews-events
// span (the view renders them from the HomedashIpc payload). Only
// geo-located events become dots; the rest live in the feed.
// Encoding (Kimler): colour = category; freshness rides
// opacity (full under 24h, dimmer to 5 days); read = grey.

export interface NewsDot {
  readonly id: string
  readonly title: string
  readonly atMs: number
  readonly lat: number
  readonly lon: number
  readonly read: boolean
  readonly category: string
  readonly place?: string
  readonly source?: string
}

/** Category palette — mirrors widgets/globenews/types.ts NEWS_CATEGORY_RGB. */
const CATEGORY_RGB: Record<string, string> = {
  conflict: "248, 113, 113",
  unrest: "167, 139, 250",
  earthquake: "251, 191, 36",
  fire: "249, 115, 22",
  weather: "56, 189, 248",
  disaster: "74, 222, 128",
}

/** Parse the events span text → geo-located dots (pure; tested). */
export const parseNewsDots = (text: string): ReadonlyArray<NewsDot> => {
  try {
    const raw = JSON.parse(text) as Array<Record<string, unknown>>
    if (!Array.isArray(raw)) return []
    const out: Array<NewsDot> = []
    for (const e of raw) {
      if (typeof e["id"] !== "string" || typeof e["lat"] !== "number" || typeof e["lon"] !== "number") continue
      const place = typeof e["place"] === "string" && e["place"] !== "" ? e["place"] : undefined
      const source = typeof e["source"] === "string" && e["source"] !== "" ? e["source"] : undefined
      out.push({
        id: e["id"],
        title: typeof e["title"] === "string" ? e["title"] : "",
        atMs: typeof e["atMs"] === "number" ? e["atMs"] : 0,
        lat: e["lat"],
        lon: e["lon"],
        read: e["read"] === true,
        category: typeof e["category"] === "string" ? e["category"] : "disaster",
        ...(place !== undefined ? { place } : {}),
        ...(source !== undefined ? { source } : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

interface GlobeSettings {
  readonly spinMs: number
  readonly density: string
  readonly glowPx: number
  readonly tiltDeg: number
  /** Threat Channel director (design §5): idle fly-to broadcast. */
  readonly cinematic: boolean
  readonly dwellSec: number
}

const parseSettings = (hook: HTMLElement): GlobeSettings => {
  const d: GlobeSettings = { spinMs: SPIN_MS, density: "rich", glowPx: 20, tiltDeg: -24, cinematic: true, dwellSec: 10 }
  const el = hook.querySelector(".mirror-field-settings")
  if (el === null || el.textContent === null || el.textContent.trim() === "") return d
  try {
    const raw = JSON.parse(el.textContent) as Record<string, unknown>
    return {
      spinMs: typeof raw["spinMinutes"] === "number" ? Math.max(10_000, raw["spinMinutes"] * 60_000) : d.spinMs,
      density: typeof raw["density"] === "string" ? raw["density"] : d.density,
      glowPx: typeof raw["glowPx"] === "number" ? raw["glowPx"] : d.glowPx,
      tiltDeg: typeof raw["tiltDeg"] === "number" ? raw["tiltDeg"] : d.tiltDeg,
      cinematic: typeof raw["cinematic"] === "boolean" ? raw["cinematic"] : d.cinematic,
      dwellSec: typeof raw["dwellSec"] === "number" ? Math.min(30, Math.max(4, raw["dwellSec"])) : d.dwellSec,
    }
  } catch {
    return d
  }
}

// ── Canvas engine ───────────────────────────────────────────────────

const SPIN_MS = 120_000
const HOME_SPIN = (-110.9 * Math.PI) / 180 // Americas facing us (harness-verified sign)
const LEAN = -0.16
/**
 * Default tilt: rotateX(θ) centres the disc on latitude −θ, so
 * −0.42 rad centres ~24°N — the USA stays in the visible band
 * through the whole rotation instead of riding the top limb.
 */
export const DEFAULT_TILT = -0.42
export const TILT_MIN = -1.05
export const TILT_MAX = 0.4
/** The latitude at the centre of the visible disc for a tilt. */
export const discCenterLatitude = (tilt: number): number => (-tilt * 180) / Math.PI
/**
 * Grab math (pure): dragging right carries the surface with the
 * cursor (spin decreases per rotateY's convention); dragging down
 * pulls the front face down, tipping the view northward (tilt
 * decreases). Tilt is clamped to a sane band.
 */
export const applyDrag = (
  spin: number,
  tilt: number,
  dx: number,
  dy: number,
  radius: number,
): { spin: number; tilt: number } => ({
  spin: spin - dx * (Math.PI / Math.max(60, radius)),
  tilt: Math.min(TILT_MAX, Math.max(TILT_MIN, tilt - dy * 0.005)),
})
// ── Camera + director math (Threat Channel, 2026-10-13) ─────
// The camera eases toward targets; the director (design §5)
// picks featured threats in the current scope and flies the
// camera to them. All pure — the engine wires them to the DOM.

/** Wrap an angle to (−π, π] so easing takes the short way. */
export const wrapAngle = (a: number): number => {
  let x = a
  while (x > Math.PI) x -= 2 * Math.PI
  while (x < -Math.PI) x += 2 * Math.PI
  return x
}

/** Exponential ease toward a target (frame-rate independent). */
export const easeToward = (cur: number, target: number, dtMs: number, tauMs = 500): number =>
  cur + (target - cur) * (1 - Math.exp(-dtMs / tauMs))

/** easeToward for angles: always the short way around. */
export const easeAngleToward = (cur: number, target: number, dtMs: number, tauMs = 500): number =>
  cur + wrapAngle(target - cur) * (1 - Math.exp(-dtMs / tauMs))

/** Spin that centres a longitude (harness-verified sign). */
export const spinForLon = (lonDeg: number): number => (lonDeg * Math.PI) / 180

/** Tilt that centres a latitude (disc centres on −tilt). */
export const tiltForLat = (latDeg: number): number => -(latDeg * Math.PI) / 180

/** Land sampling step for a zoom: deeper zoom, finer step —
 * the point cloud re-resolves as the camera descends. */
export const zoomStepFor = (baseStep: number, zoom: number): number =>
  zoom < 1.25 ? baseStep : zoom < 1.7 ? baseStep / 1.5 : zoom < 2.2 ? baseStep / 2.2 : baseStep / 3

const toVec = (lat: number, lon: number): Vec3 => {
  const phi = (lat * Math.PI) / 180
  const lam = (lon * Math.PI) / 180
  return { x: Math.cos(phi) * Math.sin(lam), y: Math.sin(phi), z: -Math.cos(phi) * Math.cos(lam) }
}

const toLatLon = (v: Vec3): { readonly lat: number; readonly lon: number } => ({
  lat: (Math.asin(Math.max(-1, Math.min(1, v.y))) * 180) / Math.PI,
  lon: (Math.atan2(v.x, -v.z) * 180) / Math.PI,
})

/** A point t∈[0,1] along the great circle from a to b (slerp). */
export const greatCirclePoint = (
  a: { readonly lat: number; readonly lon: number },
  b: { readonly lat: number; readonly lon: number },
  t: number,
): { readonly lat: number; readonly lon: number } => {
  const va = toVec(a.lat, a.lon)
  const vb = toVec(b.lat, b.lon)
  const dot = Math.max(-1, Math.min(1, va.x * vb.x + va.y * vb.y + va.z * vb.z))
  const omega = Math.acos(dot)
  if (omega < 1e-6) return { lat: a.lat, lon: a.lon }
  const s = Math.sin(omega)
  const ka = Math.sin((1 - t) * omega) / s
  const kb = Math.sin(t * omega) / s
  return toLatLon({
    x: va.x * ka + vb.x * kb,
    y: va.y * ka + vb.y * kb,
    z: va.z * ka + vb.z * kb,
  })
}

/** Destination point from a centre at a bearing + distance. */
export const ringPoint = (
  center: { readonly lat: number; readonly lon: number },
  radiusKm: number,
  bearingDeg: number,
): { readonly lat: number; readonly lon: number } => {
  const d = radiusKm / 6371
  const br = (bearingDeg * Math.PI) / 180
  const phi1 = (center.lat * Math.PI) / 180
  const lam1 = (center.lon * Math.PI) / 180
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(br),
  )
  const lam2 =
    lam1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(phi1),
      Math.cos(d) - Math.sin(phi1) * Math.sin(phi2),
    )
  return { lat: (phi2 * 180) / Math.PI, lon: (lam2 * 180) / Math.PI }
}

/** Engine-side watched places (mirror of ui/src/field-graph.ts
 * WATCHED_PLACES — the renderer cannot import the UI module). */
export const WATCHED_PLACES_ENGINE: ReadonlyArray<{ readonly name: string; readonly lat: number; readonly lon: number }> = [
  { name: "Tucson", lat: 32.2, lon: -110.9 },
  { name: "Tall Timbers", lat: 38.3, lon: -76.7 },
]

export const engineDistanceKm = (
  a: { readonly lat: number; readonly lon: number },
  b: { readonly lat: number; readonly lon: number },
): number => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

/** Initial bearing from a to b, degrees clockwise from north (pure). */
export const engineBearingDeg = (
  a: { readonly lat: number; readonly lon: number },
  b: { readonly lat: number; readonly lon: number },
): number => {
  const rad = Math.PI / 180
  const phi1 = a.lat * rad
  const phi2 = b.lat * rad
  const dLam = (b.lon - a.lon) * rad
  const y = Math.sin(dLam) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam)
  return (Math.atan2(y, x) / rad + 360) % 360
}

const COMPASS16: ReadonlyArray<string> = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]

export interface HoverCardLine {
  readonly text: string
  readonly tone: "bright" | "mid" | "dim"
}

/**
 * The hover card's lines for a dot (pure; tested): the location
 * story first (place, coordinates, distance + bearing from the
 * nearest watched place), then what happened (title, category,
 * age, source). Lines with no data behind them are omitted, never
 * faked.
 */
export const hoverCardLines = (d: NewsDot, nowMs: number): ReadonlyArray<HoverCardLine> => {
  const lines: Array<HoverCardLine> = []
  if (d.place !== undefined) lines.push({ text: d.place, tone: "bright" })
  const title = d.title.length > 58 ? `${d.title.slice(0, 57)}…` : d.title
  if (title !== "") lines.push({ text: title, tone: d.place !== undefined ? "mid" : "bright" })
  const ageMin = Math.max(0, Math.round((nowMs - d.atMs) / 60_000))
  const age =
    ageMin < 60
      ? `${ageMin}m ago`
      : ageMin < 1440
        ? `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`
        : `${Math.floor(ageMin / 1440)}d ${Math.floor((ageMin % 1440) / 60)}h ago`
  const categoryLabel = d.category.charAt(0).toUpperCase() + d.category.slice(1)
  lines.push({ text: `${categoryLabel} · ${age}${d.source !== undefined ? ` · ${d.source}` : ""}`, tone: "dim" })
  const latTxt = `${Math.abs(d.lat).toFixed(2)}°${d.lat >= 0 ? "N" : "S"}`
  const lonTxt = `${Math.abs(d.lon).toFixed(2)}°${d.lon >= 0 ? "E" : "W"}`
  let nearest: { readonly name: string; readonly lat: number; readonly lon: number } | undefined
  let nearestKm = Number.POSITIVE_INFINITY
  for (const p of WATCHED_PLACES_ENGINE) {
    const km = engineDistanceKm(d, p)
    if (km < nearestKm) {
      nearestKm = km
      nearest = p
    }
  }
  if (nearest !== undefined) {
    const rel =
      nearestKm < 1
        ? `at ${nearest.name}`
        : `${Math.round(nearestKm).toLocaleString("en-US")} km ${COMPASS16[Math.round(engineBearingDeg(nearest, d) / 22.5) % 16] ?? "N"} of ${nearest.name}`
    lines.push({ text: `${latTxt} ${lonTxt} · ${rel}`, tone: "dim" })
  } else {
    lines.push({ text: `${latTxt} ${lonTxt}`, tone: "dim" })
  }
  return lines
}

export type EngineScope = "global" | "national" | "local"

/** Scope filter, mirroring the feed's rules (design §2). */
export const scopeFilterDots = (
  dots: ReadonlyArray<NewsDot>,
  scope: EngineScope,
): ReadonlyArray<NewsDot> => {
  if (scope === "global") return dots
  if (scope === "local")
    return dots.filter((d) =>
      WATCHED_PLACES_ENGINE.some((p) => engineDistanceKm(d, p) <= 150),
    )
  return dots.filter((d) => {
    const { lat, lon } = d
    return (
      (lat >= 24.5 && lat <= 49.5 && lon >= -125 && lon <= -66.5) ||
      (lat >= 51 && lat <= 71.5 && lon >= -170 && lon <= -129.5) ||
      (lat >= 18.5 && lat <= 22.5 && lon >= -161 && lon <= -154.5)
    )
  })
}

/** The director's risk boundary: the tour lives inside the
 *  watched places' risk circles (the Local scope radius). */
export const DIRECTOR_RISK_KM = 150

/** Distance from a dot to its nearest watched place. */
const nearestEngineWatchedKm = (d: NewsDot): number => {
  let best = Number.POSITIVE_INFINITY
  for (const p of WATCHED_PLACES_ENGINE) {
    const km = engineDistanceKm(d, p)
    if (km < best) best = km
  }
  return best
}

/**
 * The director's itinerary (Kimler, 2026-10-13): the tour runs
 * NEAREST FIRST — the closest event to a watched place, then
 * the next closest, and so on, stopping at the risk boundary;
 * events beyond DIRECTOR_RISK_KM of every watched place are
 * never toured. `afterId` resumes after the last featured
 * event; past the last in-radius event the tour is OVER
 * (undefined) — it never wraps back to the closest (the wrap,
 * fed by rotation state that feature-end wiped, was the
 * zoom-in/zoom-out loop on a single event). Equal distances
 * break unread-first, then newest-first.
 */
export const pickFeature = (
  dots: ReadonlyArray<NewsDot>,
  scope: EngineScope,
  afterId?: string,
): NewsDot | undefined => {
  const pool = scopeFilterDots(dots, scope)
    .map((d) => ({ d, km: nearestEngineWatchedKm(d) }))
    .filter((x) => x.km <= DIRECTOR_RISK_KM)
    .sort((a, b) => a.km - b.km || (a.d.read === b.d.read ? b.d.atMs - a.d.atMs : a.d.read ? 1 : -1))
    .map((x) => x.d)
  if (pool.length === 0) return undefined
  if (afterId === undefined) return pool[0]
  const idx = pool.findIndex((d) => d.id === afterId)
  if (idx === -1) return pool[0]
  return pool[idx + 1]
}

const PHOSPHOR = "0, 255, 65"
const EMBER = "232, 180, 74"
export interface GlobeFrame {
  readonly cx: number
  readonly axis: number
  readonly R: number
  /** Content slot as hook fractions "fx,fy,fw,fh" for the dash editor. */
  readonly slot: string
}
/**
 * Globe + reflection fitted to the frame (2026-10-13): the widget's
 * content is the disc plus its ember reflection — 1.6R tall in all —
 * so R is set by whichever frame dimension binds the GROUP, less
 * the rim-glow margin. The published slot is the group rect plus
 * that same margin, which makes editor fitting a fixed point:
 * fitting the frame to the slot lands on exactly the same R.
 */
export const globeFrame = (w: number, h: number, glowPx: number): GlobeFrame => {
  const pad = glowPx + 4
  // R is consumed 2x across and 1.6x down (disc + reflection), so
  // each bound must reserve the margin at its own scale.
  const R = Math.max(0, Math.min(w / 2 - pad, (h - 2 * pad) / 2))
  const cx = w / 2
  const axis = (h - 2 * R) / 2 + R
  const fx = w > 0 ? (cx - R - pad) / w : 0
  const fy = h > 0 ? (axis - R - pad) / h : 0
  const fw = w > 0 ? (2 * R + 2 * pad) / w : 0
  const fh = h > 0 ? (2 * R + 2 * pad) / h : 0
  return { cx, axis, R, slot: `${fx.toFixed(4)},${fy.toFixed(4)},${fw.toFixed(4)},${fh.toFixed(4)}` }
}
const startEngine = (hook: HTMLElement): void => {
  let settings = parseSettings(hook)
  const canvas = document.createElement("canvas")
  hook.appendChild(canvas)
  const ctx = canvas.getContext("2d")
  if (ctx === null) return
  let globe = buildGlobePoints(settings.density === "calm" ? 1.7 : 1.2)
  const wallStart = Date.now()

  let width = 0
  let height = 0
  // Stage-cover canvas (Kimler, 2026-10-13): the canvas covers the
  // whole main column (.app-main), not just this widget's layer
  // box, while ALL drawing stays in hook coordinates (the
  // transform carries the offset). At zoom 1 the disc is
  // inscribed in the layer as before; when the camera zooms
  // (wheel, or the director's 1.9 feature flights) the disc
  // bleeds across the main column and only ends at its edges —
  // with a layer-sized canvas it was guillotined mid-disc at the
  // layer's right edge (read as a black panel behind the
  // neighbouring widgets), and with a stage-sized canvas the
  // disc's crown grazed the stage's top edge the same way. The
  // panel header and the home composer are raised above the
  // canvas in CSS so the bleed never eats their clicks.
  // Outside the dash (the chat empty state) there is no stage
  // ancestor and the cover degenerates to the hook box itself.
  let offX = 0
  let offY = 0
  let covW = 0
  let covH = 0
  const resize = (): void => {
    const rect = hook.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    width = Math.max(0, Math.floor(rect.width))
    height = Math.max(0, Math.floor(rect.height))
    const stage = hook.closest(".homedash-stage")
    const coverEl = stage !== null ? (hook.closest(".app-main") ?? stage) : null
    if (coverEl !== null) {
      const sr = coverEl.getBoundingClientRect()
      offX = Math.round(rect.left - sr.left)
      offY = Math.round(rect.top - sr.top)
      covW = Math.max(width, Math.floor(sr.width))
      covH = Math.max(height, Math.floor(sr.height))
    } else {
      offX = 0
      offY = 0
      covW = width
      covH = height
    }
    canvas.style.position = "absolute"
    canvas.style.left = `${-offX}px`
    canvas.style.top = `${-offY}px`
    canvas.style.width = `${covW}px`
    canvas.style.height = `${covH}px`
    canvas.width = Math.floor(covW * dpr)
    canvas.height = Math.floor(covH * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, dpr * offX, dpr * offY)
  }
  resize()
  const ro = new ResizeObserver(resize)
  ro.observe(hook)
  // A position-only geometry change (editor drag) does not resize
  // the hook, so the ResizeObserver stays silent while the offset
  // moves — watch the layer's style for exactly that case.
  const layerEl = hook.parentElement
  if (layerEl !== null) {
    new MutationObserver(resize).observe(layerEl, { attributes: true, attributeFilter: ["style"] })
  }

  // View state: the globe can be GRABBED (2026-10-13) — drag to
  // reposition the spin and adjust the tilt; release and it keeps
  // spinning, fling inertia easing back to the base rate.
  let baseVel = -(Math.PI * 2) / settings.spinMs
  const view = { spin: HOME_SPIN, tilt: (settings.tiltDeg * Math.PI) / 180, vel: baseVel, dragging: false }
  const geom = { cx: 0, axis: 0, R: 0 }
  // ── Threat Channel camera + director (design §5/§6) ──────
  // The camera eases to targets; the director features threats
  // when the user has been idle, and yields the instant they
  // interact. lastUserMs starts backdated so the broadcast
  // begins seconds after boot, not half a minute later.
  const cam = { zoom: 1, zoomT: 1, mode: "spin" as "spin" | "focus", spinT: 0, tiltT: 0 }
  let lastUserMs = performance.now() - 25_000
  let featureId: string | undefined
  let featureUntil = 0
  // Tour rotation state: survives clearFeature, which wipes
  // featureId at every feature end — that wipe WAS the stuck
  // loop (each new pick restarted from the pool's head).
  let lastFeatureId: string | undefined
  // The user's live selection (news-link owns it): while set,
  // the tour is PAUSED and the camera holds on the selected
  // event (Kimler, 2026-10-13).
  let selectedHoldId: string | undefined
  let lastDotsKey = ""
  let nextFeatureAt = performance.now() + 6_000
  let priorityId: string | undefined
  const seenDots = new Set<string>()
  const shockwaves: Array<{ lat: number; lon: number; t0: number }> = []
  let currentStep = settings.density === "calm" ? 1.7 : 1.2
  let fpsFrames = 0
  const fpsAt = performance.now()
  let fpsLogged = false
  const readScope = (): EngineScope => {
    const stage = hook.closest(".homedash-stage")
    const on = stage?.querySelector(".news-region-on")?.textContent?.trim().toLowerCase() ?? ""
    return on === "global" ? "global" : on === "national" ? "national" : "local"
  }
  const feature = (d: NewsDot, now: number): void => {
    featureId = d.id
    lastFeatureId = d.id
    cam.mode = "focus"
    cam.spinT = spinForLon(d.lon)
    cam.tiltT = Math.max(-1.15, Math.min(0.75, tiltForLat(d.lat)))
    cam.zoomT = 1.9
    featureUntil = now + settings.dwellSec * 1000 + 2500
    if (hook.dataset.feature !== d.id) hook.dataset.feature = d.id
    window.dispatchEvent(new CustomEvent("aimy:news-feature", { detail: JSON.stringify({ id: d.id }) }))
    console.warn(`[aimy] globenews: featuring ${d.id} (${d.title.slice(0, 50)})`)
  }
  const clearFeature = (): void => {
    const wasFeatured = featureId !== undefined
    featureId = undefined
    if (hook.dataset.feature !== undefined && hook.dataset.feature !== "") hook.dataset.feature = ""
    // The desk + lower-third follow the focus through the model;
    // they must hear the feature end, not just its start.
    if (wasFeatured) window.dispatchEvent(new CustomEvent("aimy:news-feature-end"))
  }
  // Selection hold (Kimler, 2026-10-13): news-link owns the
  // selection; the engine hears it land (a feed row's open, or
  // a globe pick — the engine's own dispatch included) and lift
  // (aimy:news-clear). While a selection lives the tour pauses
  // and the camera holds on the selected event.
  const holdSelection = (id: string): void => {
    if (selectedHoldId !== id) {
      selectedHoldId = id
      console.warn(`[aimy] globenews: selection hold — ${id}`)
    }
  }
  const releaseSelection = (): void => {
    if (selectedHoldId === undefined) return
    const held = selectedHoldId
    selectedHoldId = undefined
    console.warn(`[aimy] globenews: selection released — ${held}`)
    // The held feature ends promptly, not at its dwell deadline.
    if (featureId === held && cam.mode === "focus") {
      cam.mode = "spin"
      cam.zoomT = 1
      clearFeature()
      nextFeatureAt = performance.now() + 1200
    }
  }
  const selectionIdFrom = (e: Event): string | undefined => {
    try {
      const detail = JSON.parse((e as CustomEvent).detail as string) as { id?: unknown }
      return typeof detail.id === "string" && detail.id !== "" ? detail.id : undefined
    } catch {
      return undefined
    }
  }
  window.addEventListener("aimy:news-select", (e) => {
    const id = selectionIdFrom(e)
    if (id !== undefined) holdSelection(id)
  })
  window.addEventListener("aimy:news-open", (e) => {
    const id = selectionIdFrom(e)
    if (id !== undefined) holdSelection(id)
  })
  window.addEventListener("aimy:news-clear", () => releaseSelection())
  // Live settings (2026-10-13): settings ride a hidden span the view
  // re-renders on change; the engine starts once per hook, so watch
  // the span and re-derive what was baked at start (spin rate, dot
  // density, tilt). Same freeze class as the mind map's graph.
  let settingsText = hook.querySelector(".mirror-field-settings")?.textContent ?? ""
  // World events (2026-10-13): same live-span discipline — the
  // engine starts once per hook, so the events span is watched and
  // re-parsed when the view re-renders (a scan landing, a read).
  let eventsText = hook.querySelector(".globenews-events")?.textContent ?? ""
  let dots: ReadonlyArray<NewsDot> = parseNewsDots(eventsText)
  for (const d of dots) seenDots.add(d.id)
  // Screen positions from the latest frame, for picking + the
  // news-link overlay (published via hook.dataset.dots each frame).
  const dotScreen = new Map<string, { x: number; y: number; visible: boolean }>()
  console.warn(`[aimy] globenews: engine start — spinMs=${settings.spinMs} density=${settings.density} glow=${settings.glowPx} tilt=${settings.tiltDeg} events=${dots.length}`)
  const spanWatch = new MutationObserver(() => {
    if (!canvas.isConnected) {
      spanWatch.disconnect()
      return
    }
    const nextText = hook.querySelector(".mirror-field-settings")?.textContent ?? ""
    if (nextText === settingsText) return
    settingsText = nextText
    const prev = settings
    settings = parseSettings(hook)
    baseVel = -(Math.PI * 2) / settings.spinMs
    if (settings.density !== prev.density) {
      currentStep = zoomStepFor(settings.density === "calm" ? 1.7 : 1.2, cam.zoom)
      globe = buildGlobePoints(currentStep)
    }
    if (!view.dragging) view.tilt = (settings.tiltDeg * Math.PI) / 180
    console.warn(`[aimy] globenews: settings reloaded — spinMs=${settings.spinMs} density=${settings.density} glow=${settings.glowPx} tilt=${settings.tiltDeg}`)
  })
  const eventsWatch = new MutationObserver(() => {
    if (!canvas.isConnected) {
      eventsWatch.disconnect()
      return
    }
    const nextText = hook.querySelector(".globenews-events")?.textContent ?? ""
    if (nextText === eventsText) return
    eventsText = nextText
    dots = parseNewsDots(nextText)
    // A changed pool restarts the tour from the closest event.
    const dotsKey = dots
      .map((d) => d.id)
      .sort()
      .join(",")
    if (dotsKey !== lastDotsKey) {
      lastDotsKey = dotsKey
      lastFeatureId = undefined
    }
    // New arrivals (Threat Channel): a shockwave on the globe,
    // and the director features the freshest one first.
    for (const d of dots) {
      if (!seenDots.has(d.id)) {
        seenDots.add(d.id)
        if (Date.now() - d.atMs < 15 * 60_000) {
          shockwaves.push({ lat: d.lat, lon: d.lon, t0: performance.now() })
          if (priorityId === undefined) priorityId = d.id
        }
      }
    }
    console.warn(`[aimy] globenews: events reloaded — ${dots.length} geo event(s)`)
  })
  eventsWatch.observe(hook, { childList: true, subtree: true, characterData: true })
  spanWatch.observe(hook, { childList: true, subtree: true, characterData: true })
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  let dragLast: { x: number; y: number; t: number } | null = null
  let dragVel = 0
  // Dot picking (2026-10-13): a press that doesn't travel is a
  // click; the nearest visible dot within reach wins.
  let downAt: { x: number; y: number } | null = null
  let hoverDot = false
  // Hover state (Kimler, 2026-10-13): the dot under the cursor
  // (drives the hover card) and whether the cursor is over the
  // disc at all (drives the spin pause in tick).
  let hoverDotId: string | undefined
  let hoverGlobe = false
  const nearestDot = (px: number, py: number, within: number): NewsDot | undefined => {
    let best: NewsDot | undefined
    let bestD = within
    for (const d of dots) {
      const s = dotScreen.get(d.id)
      if (s === undefined || !s.visible) continue
      const dist = Math.hypot(px - s.x, py - s.y)
      if (dist < bestD) {
        bestD = dist
        best = d
      }
    }
    return best
  }

  canvas.addEventListener("pointermove", (e) => {
    if (view.dragging && dragLast !== null) {
      const rect = canvas.getBoundingClientRect()
      const px = e.clientX - rect.left - offX
      const py = e.clientY - rect.top - offY
      const dx = px - dragLast.x
      const dy = py - dragLast.y
      const next = applyDrag(view.spin, view.tilt, dx, dy, geom.R)
      const now = performance.now()
      const dtMs = Math.max(1, now - dragLast.t)
      dragVel = (next.spin - view.spin) / dtMs
      view.spin = next.spin
      view.tilt = next.tilt
      dragLast = { x: px, y: py, t: now }
      if (reducedMotion) draw(performance.now())
    }
  })
  canvas.addEventListener("pointerdown", (e) => {
    // The user takes the con: the director yields, the feature
    // clears, the idle clock restarts.
    lastUserMs = performance.now()
    if (cam.mode === "focus") cam.mode = "spin"
    clearFeature()
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left - offX
    const py = e.clientY - rect.top - offY
    downAt = { x: px, y: py }
    if (Math.hypot(px - geom.cx, py - geom.axis) <= geom.R * 1.15 && geom.R > 0) {
      view.dragging = true
      dragVel = 0
      dragLast = { x: px, y: py, t: performance.now() }
      canvas.setPointerCapture(e.pointerId)
      canvas.style.cursor = "grabbing"
    }
  })
  const endDrag = (): void => {
    if (!view.dragging) return
    view.dragging = false
    view.vel = Math.max(-0.012, Math.min(0.012, dragVel))
    dragLast = null
  }
  canvas.addEventListener("pointerup", endDrag)
  canvas.addEventListener("pointercancel", endDrag)
  canvas.addEventListener("pointerup", (e) => {
    if (downAt === null) return
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left - offX
    const py = e.clientY - rect.top - offY
    const travelled = Math.hypot(px - downAt.x, py - downAt.y)
    downAt = null
    if (travelled >= 6) return
    const hit = nearestDot(px, py, 12)
    if (hit === undefined) return
    // Selecting on the globe: the link module draws the line to
    // the feed row, the event counts as read (cyan ring), and the
    // article opens in the drawer (Kimler, 2026-10-13).
    const detail = JSON.stringify({ id: hit.id, origin: "globe" })
    window.dispatchEvent(new CustomEvent("aimy:news-select", { detail }))
    window.dispatchEvent(new CustomEvent("aimy:news-read", { detail: JSON.stringify({ id: hit.id }) }))
    window.dispatchEvent(new CustomEvent("aimy:news-open", { detail: JSON.stringify({ id: hit.id }) }))
    console.warn(`[aimy] globenews: dot picked — ${hit.id} (${hit.title.slice(0, 60)})`)
  })
  canvas.addEventListener("pointermove", (e) => {
    if (view.dragging) return
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left - offX
    const py = e.clientY - rect.top - offY
    const hit = nearestDot(px, py, 12)
    hoverDot = hit !== undefined
    hoverDotId = hit?.id
    hoverGlobe = geom.R > 0 && Math.hypot(px - geom.cx, py - geom.axis) <= geom.R * 1.15
    if (reducedMotion) draw(performance.now())
  })
  canvas.addEventListener("pointerleave", () => {
    hoverDot = false
    hoverDotId = undefined
    hoverGlobe = false
    if (reducedMotion) draw(performance.now())
  })
  // Zoom (Threat Channel): the wheel descends toward the cursor's
  // hemisphere — zoom target only; rotation stays the user's or
  // the director's. Double-click a dot flies to it.
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault()
      lastUserMs = performance.now()
      if (cam.mode === "focus") cam.mode = "spin"
      clearFeature()
      cam.zoomT = Math.max(1, Math.min(2.6, cam.zoomT * (e.deltaY < 0 ? 1.18 : 1 / 1.18)))
    },
    { passive: false },
  )
  canvas.addEventListener("dblclick", (e) => {
    const rect = canvas.getBoundingClientRect()
    const hit = nearestDot(e.clientX - rect.left - offX, e.clientY - rect.top - offY, 14)
    if (hit === undefined) return
    lastUserMs = performance.now()
    feature(hit, performance.now())
  })

  const draw = (tMs: number): void => {
    if (width === 0 || height === 0) return
    ctx.clearRect(-offX, -offY, covW, covH)
    const frame = globeFrame(width, height, settings.glowPx)
    const cx = frame.cx
    const axis = frame.axis
    const R = frame.R
    // Camera zoom scales the effective disc (Threat Channel §6).
    const Re = R * cam.zoom
    geom.cx = cx
    geom.axis = axis
    geom.R = Re
    if (hook.dataset.content !== frame.slot) hook.dataset.content = frame.slot
    // Disc geometry for the news-link overlay: when a selected
    // event is on the far side, the line pins to the limb at the
    // event's bearing — it needs centre + radius in HOOK px
    // (the coordinate system all engine drawing lives in; the
    // canvas element's own box is the whole main column).
    const discAttr = `${cx.toFixed(1)},${axis.toFixed(1)},${Re.toFixed(1)}`
    if (hook.dataset.disc !== discAttr) hook.dataset.disc = discAttr
    canvas.style.cursor = view.dragging ? "grabbing" : hoverDot ? "pointer" : "grab"
    const focal = 3.4
    const breath = 0.92 + 0.08 * Math.sin((tMs * Math.PI * 2) / 6000)
    const spinV = (p: GlobePoint): Vec3 => rotateX(rotateZ(rotateY(p.vec, view.spin), LEAN), view.tilt)
    // View window for culling at depth: only points near the
    // camera's lat/lon window are projected at all.
    const centerLonDeg = ((view.spin * 180) / Math.PI + 540) % 360 - 180
    const centerLatDeg = discCenterLatitude(view.tilt)
    const lonHalf = Math.min(180, 100 / cam.zoom + 28)
    const latHalf = Math.min(95, 72 / cam.zoom + 28)
    const inWindow = (lon: number, lat: number): boolean =>
      Math.abs(lat - centerLatDeg) <= latHalf &&
      Math.abs(wrapAngle(((lon - centerLonDeg) * Math.PI) / 180)) * (180 / Math.PI) <= lonHalf

    // The sphere's body (Kimler, 2026-10-13): the disc is a solid
    // planet, not a window — the stage's starfield must not show
    // through the oceans. A radial shade (lift toward the upper
    // left, darkening to the limb) keeps it a sphere rather than
    // a sticker; the dots, lattice, and rim glow paint over it.
    // Scales with Re, so a zoomed disc occludes as it bleeds.
    if (Re > 0) {
      const bodyGrad = ctx.createRadialGradient(cx - Re * 0.35, axis - Re * 0.38, Re * 0.1, cx, axis, Re)
      bodyGrad.addColorStop(0, "rgba(13, 21, 36, 1)")
      bodyGrad.addColorStop(0.55, "rgba(9, 14, 24, 1)")
      bodyGrad.addColorStop(1, "rgba(4, 6, 11, 1)")
      ctx.beginPath()
      ctx.arc(cx, axis, Re, 0, Math.PI * 2)
      ctx.fillStyle = bodyGrad
      ctx.fill()
    }

    // ── The earth above ──
    for (const p of globe) {
      if (!inWindow(p.lon, p.lat)) continue
      const v = spinV(p)
      const s = project(v, cx, axis, Re, focal)
      const facing = Math.max(0, -v.z)
      const back = v.z > 0
      const a = (back ? 0.028 : 0.05 + 0.30 * facing) * breath
      ctx.beginPath()
      ctx.arc(s.x, s.y, back ? 0.9 : 1.25, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(196, 255, 210, ${a.toFixed(3)})`
      ctx.fill()
    }
    // Cyan glow around the rim (2026-10-13): layered strokes falling
    // off outward — the widest band reaches ~20px past the rim.
    const GLOW_BANDS: ReadonlyArray<readonly [number, number]> = [
      [2.2, 0.014],
      [1.2, 0.03],
      [0.5, 0.06],
      [0.125, 0.1],
      [0.05, 0.16],
    ]
    const glowBands: ReadonlyArray<readonly [number, number]> =
      settings.glowPx <= 0
        ? []
        : GLOW_BANDS.map(([f, a]) => [Math.max(0.6, f * settings.glowPx), a] as const)
    for (const [lw, a] of glowBands) {
      ctx.beginPath()
      ctx.arc(cx, axis, Re * 1.02, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(34, 211, 238, ${a})`
      ctx.lineWidth = lw
      ctx.stroke()
    }
    // Graticule (tactical layer): lat/lon grid on the sphere,
    // fading IN with zoom — the descent reveals the chart.
    {
      const gAlpha = 0.03 + 0.09 * Math.min(1, Math.max(0, (cam.zoom - 1) / 1.6))
      ctx.strokeStyle = `rgba(120, 220, 255, ${gAlpha.toFixed(3)})`
      ctx.lineWidth = 0.5
      const traceLine = (pts: Array<{ lat: number; lon: number }>): void => {
        ctx.beginPath()
        let pen = false
        for (const pt of pts) {
          const v = spinV({ vec: toVec(pt.lat, pt.lon), lon: pt.lon, lat: pt.lat })
          if (v.z >= 0) {
            pen = false
            continue
          }
          const s = project(v, cx, axis, Re, focal)
          if (!pen) {
            ctx.moveTo(s.x, s.y)
            pen = true
          } else ctx.lineTo(s.x, s.y)
        }
        ctx.stroke()
      }
      for (let lat = -60; lat <= 75; lat += 15) {
        const pts: Array<{ lat: number; lon: number }> = []
        for (let lon = -180; lon <= 180; lon += 4) pts.push({ lat, lon })
        traceLine(pts)
      }
      for (let lon = -180; lon < 180; lon += 15) {
        const pts: Array<{ lat: number; lon: number }> = []
        for (let lat = -82; lat <= 84; lat += 4) pts.push({ lat, lon })
        traceLine(pts)
      }
    }
    const homePhi = (HOME.lat * Math.PI) / 180
    const homeLam = (HOME.lon * Math.PI) / 180
    const homeVec: Vec3 = {
      x: Math.cos(homePhi) * Math.sin(homeLam),
      y: Math.sin(homePhi),
      z: -Math.cos(homePhi) * Math.cos(homeLam),
    }
    const hv = spinV({ vec: homeVec, lon: HOME.lon, lat: HOME.lat })
    if (hv.z < 0.15) {
      const hs = project(hv, cx, axis, Re, focal)
      const pulse = 0.55 + 0.35 * Math.sin(tMs / 900)
      ctx.beginPath()
      ctx.arc(hs.x, hs.y, 5.5, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${PHOSPHOR}, ${(0.10 * pulse).toFixed(3)})`
      ctx.fill()
      ctx.beginPath()
      ctx.arc(hs.x, hs.y, 2.1, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(235, 255, 240, ${(0.55 * pulse + 0.25).toFixed(3)})`
      ctx.fill()
    }
    const grad = ctx.createLinearGradient(0, 0, width, 0)
    grad.addColorStop(0, "rgba(255, 255, 255, 0)")
    grad.addColorStop(0.5, "rgba(255, 255, 255, 0.10)")
    grad.addColorStop(1, "rgba(255, 255, 255, 0)")
    ctx.fillStyle = grad
    ctx.fillRect(0, axis - 0.5, width, 1)

    // ── World events on the disc (2026-10-13) ──
    // Front face only (v.z < 0.02): a far-side event is not drawn —
    // its link line (news-link) pins to the limb at its bearing.
    // Positions publish via hook.dataset.dots (HOOK px) for
    // the link overlay and for click picking. Colour = CATEGORY
    // (Kimler, 2026-10-13); freshness rides opacity (full under
    // 24h, dimmer to 5 days); read events go grey.
    const nowMs = Date.now()
    let dotsJson = ""
    for (const d of dots) {
      const phi = (d.lat * Math.PI) / 180
      const lam = (d.lon * Math.PI) / 180
      const vec: Vec3 = {
        x: Math.cos(phi) * Math.sin(lam),
        y: Math.sin(phi),
        z: -Math.cos(phi) * Math.cos(lam),
      }
      const v = spinV({ vec, lon: d.lon, lat: d.lat })
      const visible = v.z < 0.02
      const s = project(v, cx, axis, Re, focal)
      dotScreen.set(d.id, { x: s.x, y: s.y, visible })
      dotsJson += `${dotsJson === "" ? "" : ","}{"id":${JSON.stringify(d.id)},"x":${s.x.toFixed(1)},"y":${s.y.toFixed(1)},"v":${visible ? 1 : 0}}`
      if (!visible) continue
      // Read events go grey (Kimler, 2026-10-13): the cyan-ring
      // read treatment is gone, in the feed and on the globe alike.
      const rgb = d.read ? "148, 163, 184" : (CATEGORY_RGB[d.category] ?? "74, 222, 128")
      const fresh = nowMs - d.atMs < 86_400_000
      ctx.beginPath()
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${rgb}, ${fresh ? 0.16 : 0.09})`
      ctx.fill()
      ctx.beginPath()
      ctx.arc(s.x, s.y, 3.2, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${rgb}, ${fresh ? 0.95 : 0.55})`
      ctx.fill()
    }
    const dotsAttr = `[${dotsJson}]`
    if (hook.dataset.dots !== dotsAttr) hook.dataset.dots = dotsAttr

    // ── Tactical layer (Threat Channel §6) ──────────────────
    const projectLatLon = (lat: number, lon: number): { x: number; y: number; front: boolean } => {
      const v = spinV({ vec: toVec(lat, lon), lon, lat })
      const s = project(v, cx, axis, Re, focal)
      return { x: s.x, y: s.y, front: v.z < 0.02 }
    }
    // Range rings around watched places, revealed by the descent.
    // Severity grammar (Kimler, 2026-10-13): the inner ring is
    // red, the outer rings yellow — and all a touch more visible.
    const ringFade = Math.min(1, Math.max(0, (cam.zoom - 1.05) / 0.45))
    if (ringFade > 0) {
      for (const place of WATCHED_PLACES_ENGINE) {
        for (const [rKm, rgb, rAlpha] of [[100, "248,113,113", 0.26], [500, "250,204,21", 0.17], [1000, "250,204,21", 0.10]] as const) {
          ctx.beginPath()
          let pen = false
          for (let b = 0; b <= 360; b += 5) {
            const pt = ringPoint(place, rKm, b)
            const s = projectLatLon(pt.lat, pt.lon)
            if (!s.front) {
              pen = false
              continue
            }
            if (!pen) {
              ctx.moveTo(s.x, s.y)
              pen = true
            } else ctx.lineTo(s.x, s.y)
          }
          ctx.strokeStyle = `rgba(${rgb}, ${(rAlpha * ringFade).toFixed(3)})`
          ctx.lineWidth = 0.75
          ctx.stroke()
        }
      }
    }
    // The featured threat: inbound arc to the nearest watched
    // place, lock-on brackets, and a data tag.
    const featured = featureId !== undefined ? dots.find((d) => d.id === featureId) : undefined
    if (featured !== undefined) {
      const fs = dotScreen.get(featured.id)
      let nearest: { name: string; lat: number; lon: number } | undefined
      let nearestKm = Number.POSITIVE_INFINITY
      for (const p of WATCHED_PLACES_ENGINE) {
        const km = engineDistanceKm(featured, p)
        if (km < nearestKm) {
          nearestKm = km
          nearest = p
        }
      }
      if (nearest !== undefined) {
        ctx.beginPath()
        let pen = false
        for (let i = 0; i <= 40; i++) {
          const pt = greatCirclePoint(featured, nearest, i / 40)
          const s = projectLatLon(pt.lat, pt.lon)
          if (!s.front) {
            pen = false
            continue
          }
          if (!pen) {
            ctx.moveTo(s.x, s.y)
            pen = true
          } else ctx.lineTo(s.x, s.y)
        }
        ctx.strokeStyle = "rgba(34, 211, 238, 0.55)"
        ctx.lineWidth = 1.1
        ctx.setLineDash([5, 5])
        ctx.lineDashOffset = -tMs / 45
        ctx.stroke()
        ctx.setLineDash([])
      }
      if (fs !== undefined && fs.visible) {
        const half = 11
        const arm = 5
        ctx.strokeStyle = "rgba(34, 211, 238, 0.9)"
        ctx.lineWidth = 1.5
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          ctx.beginPath()
          ctx.moveTo(fs.x + sx * half, fs.y + sy * half - sy * (half - arm))
          ctx.lineTo(fs.x + sx * half, fs.y + sy * half)
          ctx.lineTo(fs.x + sx * half - sx * (half - arm), fs.y + sy * half)
          ctx.stroke()
        }
        // Data tag: name, distance from the watched place, age.
        const ageMin = Math.max(0, Math.round((nowMs - featured.atMs) / 60_000))
        const ageText = ageMin < 60 ? `${ageMin}m` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m`
        const lines = [
          featured.title.slice(0, 32),
          nearest !== undefined ? `${Math.round(nearestKm).toLocaleString()} km · ${nearest.name} · ${ageText} old` : ageText,
        ]
        ctx.font = "10px 'IBM Plex Mono', ui-monospace, monospace"
        const tagW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14
        const tagX = Math.min(width - tagW - 6, fs.x + 16)
        const tagY = Math.max(6, fs.y - 34)
        ctx.fillStyle = "rgba(3, 10, 8, 0.78)"
        ctx.fillRect(tagX, tagY, tagW, 30)
        ctx.strokeStyle = "rgba(34, 211, 238, 0.45)"
        ctx.lineWidth = 0.5
        ctx.strokeRect(tagX, tagY, tagW, 30)
        ctx.fillStyle = "rgba(210, 255, 225, 0.92)"
        ctx.fillText(lines[0] ?? "", tagX + 7, tagY + 12)
        ctx.fillStyle = "rgba(140, 220, 190, 0.85)"
        ctx.fillText(lines[1] ?? "", tagX + 7, tagY + 24)
      }
    }
    // Arrival shockwaves: one expanding ring per fresh event.
    for (let i = shockwaves.length - 1; i >= 0; i--) {
      const sw = shockwaves[i]!
      const age = (tMs - sw.t0) / 1600
      if (age >= 1) {
        shockwaves.splice(i, 1)
        continue
      }
      const s = projectLatLon(sw.lat, sw.lon)
      if (!s.front) continue
      const ease = 1 - (1 - age) ** 3
      ctx.beginPath()
      ctx.arc(s.x, s.y, 6 + ease * 30, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(150, 255, 200, ${((1 - age) * 0.5).toFixed(3)})`
      ctx.lineWidth = 1.2
      ctx.stroke()
    }

    // ── The reflection: the earth, warped ──
    // The reflection belongs to the wide shot (design §6): it
    // fades as the camera descends.
    const reflectFade = cam.zoom <= 1 ? 1 : Math.max(0, 1 - (cam.zoom - 1) / 0.8)
    if (reflectFade > 0) {
      for (const p of globe) {
        if (!inWindow(p.lon, p.lat)) continue
        const v = spinV(p)
        const s = project(v, cx, axis, Re, focal)
        const ry = axis + (reflectY(s.y, axis) - axis) * 0.60
        const rx = s.x + Math.sin(ry * 0.045 + tMs * 0.0006) * 1.5
        if (ry < axis + 4) continue
        const facing = Math.max(0, -v.z)
        ctx.beginPath()
        ctx.arc(rx, ry, 1.05, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${EMBER}, ${((0.012 + 0.05 * facing) * breath * reflectFade).toFixed(3)})`
        ctx.fill()
      }
    }

    // ── Readouts (tactical layer): camera position + clock ──
    if (width > 320) {
      ctx.font = "10px 'IBM Plex Mono', ui-monospace, monospace"
      ctx.fillStyle = "rgba(170, 240, 200, 0.5)"
      const latTxt = `${Math.abs(centerLatDeg).toFixed(1)}°${centerLatDeg >= 0 ? "N" : "S"}`
      const lonTxt = `${Math.abs(centerLonDeg).toFixed(1)}°${centerLonDeg >= 0 ? "E" : "W"}`
      ctx.fillText(`CAM ${latTxt} ${lonTxt} · Z ${cam.zoom.toFixed(2)}`, 10, height - 10)
      const clock = new Date().toLocaleTimeString("en-GB")
      const clockW = ctx.measureText(clock).width
      ctx.fillText(clock, width - clockW - 10, height - 10)
    }

    // ── Hover card (Kimler, 2026-10-13) ──
    // The dot under the cursor gets its location story: place,
    // title, category · age · source, and coordinates with the
    // distance + bearing from the nearest watched place. Drawn
    // last, over everything; clamped to the STAGE (the canvas
    // covers it now), so a dot near the layer's edge still gets a
    // whole card. Family with the featured data tag: same mono,
    // same dark glass, category-coloured edge.
    if (hoverDotId !== undefined && !view.dragging) {
      const hd = dots.find((x) => x.id === hoverDotId)
      const hs = hd !== undefined ? dotScreen.get(hd.id) : undefined
      if (hd !== undefined && hs !== undefined && hs.visible) {
        const lines = hoverCardLines(hd, nowMs)
        ctx.font = "11px 'IBM Plex Mono', ui-monospace, monospace"
        const cardW = Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + 18
        const cardH = lines.length * 15 + 13
        const minX = -offX + 6
        const maxX = -offX + covW - cardW - 6
        const minY = -offY + 6
        const maxY = -offY + covH - cardH - 6
        let cardX = hs.x + 14
        if (cardX > maxX) cardX = hs.x - cardW - 14
        cardX = Math.min(Math.max(cardX, minX), Math.max(minX, maxX))
        let cardY = hs.y - cardH - 12
        if (cardY < minY) cardY = hs.y + 16
        cardY = Math.min(Math.max(cardY, minY), Math.max(minY, maxY))
        const rgb = hd.read ? "148, 163, 184" : (CATEGORY_RGB[hd.category] ?? "74, 222, 128")
        ctx.beginPath()
        ctx.roundRect(cardX, cardY, cardW, cardH, 7)
        ctx.fillStyle = "rgba(3, 10, 8, 0.86)"
        ctx.fill()
        ctx.strokeStyle = `rgba(${rgb}, 0.55)`
        ctx.lineWidth = 0.75
        ctx.stroke()
        lines.forEach((l, li) => {
          ctx.fillStyle =
            l.tone === "bright"
              ? "rgba(233, 246, 238, 0.96)"
              : l.tone === "mid"
                ? "rgba(198, 219, 206, 0.88)"
                : "rgba(143, 196, 168, 0.82)"
          ctx.fillText(l.text, cardX + 9, cardY + 17 + li * 15)
        })
      }
    }
  }


  if (reducedMotion) {
    draw(0)
    canvas.classList.add("on")
    // No loop — but a deliberate drag still re-frames the globe:
    // the pointermove handler redraws on drag. The ResizeObserver
    // stays attached for the same reason.
    return
  }
  let raf = 0
  let last = performance.now()
  let stopped = false
  const stop = (): void => {
    stopped = true
    cancelAnimationFrame(raf)
    ro.disconnect()
  }
  const tick = (now: number): void => {
    if (stopped) return
    if (!canvas.isConnected) {
      stop()
      return
    }
    const dt = Math.min(now - last, 100)
    last = now
    if (!document.hidden) {
      if (!view.dragging) {
        if (cam.mode === "focus") {
          // Selection switch: a fresh selection re-aims even
          // mid-feature — the user's pick outranks the tour.
          if (selectedHoldId !== undefined && featureId !== selectedHoldId) {
            const held = dots.find((d) => d.id === selectedHoldId)
            if (held !== undefined) feature(held, now)
            else selectedHoldId = undefined
          }
          // Flying: ease the camera to the featured threat.
          view.spin = easeAngleToward(view.spin, cam.spinT, dt, 650)
          view.tilt = easeToward(view.tilt, cam.tiltT, dt, 650)
          view.vel = baseVel
          if (now > featureUntil && featureId !== selectedHoldId) {
            cam.mode = "spin"
            cam.zoomT = 1
            clearFeature()
            nextFeatureAt = now + 1200
          }
        } else {
          // Fling inertia eases back to the base spin rate (~0.8 s).
          // Hover pause (Kimler, 2026-10-13): while the cursor is
          // over the disc the ambient target is 0 — the globe
          // settles so a dot can be hovered, read, and clicked
          // without drift, and resumes when the cursor leaves.
          const targetVel = hoverGlobe ? 0 : baseVel
          view.vel += (targetVel - view.vel) * (1 - Math.exp(-dt / 800))
          view.spin += view.vel * dt
          // The director (design §5): a live selection PAUSES
          // the tour — once the user has been hands-off briefly,
          // the camera settles on the selected event and holds
          // (the focus branch never times a held feature out).
          // Otherwise, idle + cinematic → walk the itinerary:
          // nearest first, out to the risk boundary.
          if (settings.cinematic && now >= nextFeatureAt) {
            if (selectedHoldId !== undefined) {
              if (featureId !== selectedHoldId && now - lastUserMs > 1500) {
                const held = dots.find((d) => d.id === selectedHoldId)
                if (held !== undefined) feature(held, now)
                else selectedHoldId = undefined
              }
            } else if (now - lastUserMs > 30_000) {
              let next: NewsDot | undefined
              if (priorityId !== undefined) {
                next = dots.find((d) => d.id === priorityId)
                priorityId = undefined
              }
              next ??= pickFeature(dots, readScope(), lastFeatureId)
              if (next !== undefined) feature(next, now)
              else nextFeatureAt = now + 5000
            }
          }
        }
        cam.zoom = easeToward(cam.zoom, cam.zoomT, dt, 550)
        // Density follows depth: rebuild the point set when the
        // zoom band changes (never per frame).
        const baseStep = settings.density === "calm" ? 1.7 : 1.2
        const step = zoomStepFor(baseStep, cam.zoom)
        if (step !== currentStep) {
          currentStep = step
          globe = buildGlobePoints(step)
        }
      }
      draw(now)
      // Frame-rate instrument (verify-on-hardware): one line in
      // the trace after ~6 s of running, so smoothness is a
      // measurement, not a hope.
      fpsFrames++
      if (!fpsLogged && now - fpsAt > 6000) {
        fpsLogged = true
        console.warn(
          `[aimy] globenews: fps≈${Math.round(fpsFrames / ((now - fpsAt) / 1000))} (zoom ${cam.zoom.toFixed(2)}, step ${currentStep}, points ${globe.length})`,
        )
      }
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  requestAnimationFrame(() => canvas.classList.add("on"))
}


/** Boot entry (called from main.ts): watch for the hook, start engines. */
export const startMirrorField = (): void => {
  const started = new WeakSet<HTMLElement>()
  const scan = (): void => {
    document.querySelectorAll<HTMLElement>(".mirror-field-hook").forEach((hook) => {
      if (!started.has(hook)) {
        started.add(hook)
        startEngine(hook)
      }
    })
  }
  scan()
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true })
}
