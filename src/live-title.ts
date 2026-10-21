/**
 * The title-cut rules shared by the subagent pane title (`buildPaneTitle` in
 * `launch.ts`). The live first-prompt title stays a pi-extension feature of
 * pi-luvus/pmux; foreman panes only need the launch-time title.
 */

/** Characters that cannot appear in an OSC title: C0, DEL, and C1 controls. */
// eslint-disable-next-line no-control-regex -- these are the characters being stripped
const TITLE_CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

/** Longest prompt line kept in a title. */
export const PROMPT_TITLE_MAX_CHARS = 48;

/** Strip OSC-illegal control characters and trim. */
export function cleanTitleText(text: string): string {
  return text.replace(TITLE_CONTROL_CHARS, "").trim();
}

/**
 * First non-empty line of `text`, control characters stripped, trimmed, and
 * cut to `PROMPT_TITLE_MAX_CHARS` characters. Returns "" when no line carries
 * printable text.
 */
export function cutPromptTitle(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    return Array.from(cleanTitleText(line))
      .slice(0, PROMPT_TITLE_MAX_CHARS)
      .join("");
  }
  return "";
}
