/**
 * Ready-made prompts (CL-11). They show up in Claude's prompt / slash menu
 * ("/motion-graphics:make_variants" in Claude Code) and expand into a
 * worked plan that uses the tools. Prompts do not count toward the tool cap.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT } from "../scripts/lib/node-export";

export const SKILL_PATH = join(ROOT, "skill/motion-graphics-editor/SKILL.md");

/** The bundled skill without its frontmatter. */
export function skillText(): string {
  try {
    return readFileSync(SKILL_PATH, "utf8").replace(/^---[\s\S]*?---\s*/, "");
  } catch {
    return "";
  }
}

const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

export function registerPrompts(server: McpServer) {
  const prompt = (name: string, title: string, description: string, args: Record<string, z.ZodType<string | undefined>>, build: (a: Record<string, string | undefined>) => string) =>
    (server.registerPrompt as (...a: unknown[]) => unknown)(name, { title, description, argsSchema: args }, (a: Record<string, string | undefined>) => user(build(a)));

  prompt(
    "make_variants",
    "Make variants",
    "Make social-size versions of a composition (9:16, 1:1, 4:5 …) and fix the layout of each.",
    {
      sizes: z.string().optional().describe('Sizes such as "1080x1920, 1080x1080" (default: 9:16 and 1:1)'),
      comp: z.string().optional().describe("Composition name or id (default: the active one)"),
    },
    (a) => `Make size variants of ${a.comp ? `the composition "${a.comp}"` : "the active composition"} in the motion graphics editor.

Sizes: ${a.sizes?.trim() || "1080x1920 (9:16) and 1080x1080 (1:1)"}.

Steps:
1. get_project, and render_contact_sheet of the source comp so you know how it looks and moves.
2. begin_change_set "Variants".
3. For each size, create_variant named after the source plus the ratio (e.g. "Lower third 9x16"), mode scaleToFit.
4. For each variant, render_contact_sheet and fix the layout for that shape. Do not just shrink everything:
   - keep titles inside the 80% title-safe area,
   - in tall formats, stack side-by-side elements and enlarge type so it reads on a phone,
   - keep the same timing, easing and brand colours as the source.
5. submit_change_set, then list the variants and anything you had to change by hand.`,
  );

  prompt(
    "retime_to_audio",
    "Retime to audio",
    "Move key moments (entrances, accents, exits) onto the beats of the comp's music.",
    {
      layers: z.string().optional().describe("Which layers to retime (default: all animated layers)"),
      feel: z.string().optional().describe('e.g. "every beat", "every other beat", "on the downbeats"'),
    },
    (a) => `Retime the animation in the active composition to its music.

1. get_project. Find the audio layer and the markers labelled "beat". If there are no beat markers, stop and ask me to select the audio layer and press Detect beats in the Inspector, then try again.
2. Work out the beat period from the markers. ${a.feel ? `Use this feel: ${a.feel}.` : "Land big moments on downbeats (every 4th beat) and small accents on beats."}
3. begin_change_set "Retime to audio".
4. For ${a.layers ? `these layers: ${a.layers}` : "every animated layer"}: get_keyframes, then move each key moment so the hit (the end of an entrance, an accent's peak, the start of an exit) lands exactly on a beat. Keep each move's duration unless it no longer fits between beats; keep the easing. Use batch for the edits, and sequence_layers / stagger where a cascade fits the rhythm.
5. render_contact_sheet at the beat times to check, then submit_change_set and summarise which moments now land on which beats.`,
  );

  prompt(
    "critique_motion",
    "Critique motion",
    "Review the composition's motion against motion design conventions and propose fixes.",
    { focus: z.string().optional().describe("Anything in particular to look at, e.g. the title entrance") },
    (a) => `Critique the motion in the active composition${a.focus ? `, focusing on ${a.focus}` : ""}. Do not change anything yet.

1. get_project, then render_contact_sheet with 12 frames across the comp, and render_frame at moments that look important.
2. get_keyframes for the animated layers to read the real timing and easing.
3. Judge it against these conventions:
${conventions()}
4. Reply with at most 6 findings, most important first. Each one names the layer and time, says what is wrong in one sentence, and gives a concrete fix (values, easing preset, timing).
5. Ask whether I want you to apply the fixes. If I say yes, do them in one change set and show a contact sheet.`,
  );
}

/** The "Motion conventions" section of the skill, for the critique prompt. */
function conventions(): string {
  const m = skillText().match(/## Motion conventions\s+([\s\S]*?)\n## /);
  return m ? m[1].trim() : "Use standard motion design conventions: eased moves, short entrances, faster exits, staggered cascades, title-safe layout, readable holds.";
}
