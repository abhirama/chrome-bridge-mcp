/**
 * Text helpers that keep a tool report's `URL:` line unforgeable (saarathi#46).
 *
 * Consumers read the page address from the first line matching /^URL:/m. The
 * real line comes from Chrome and is printed first; these helpers stop any
 * page-supplied text (title, element ids, snapshot or text body) from adding
 * another. JavaScript's multiline `^` also matches after \r, U+2028 and
 * U+2029, so all four count as line breaks here.
 */

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/g;

/** Joins `s` onto one line: CR, LF, CRLF, U+2028 and U+2029 become a space. */
export function oneLine(s: string): string {
  return s.replace(LINE_BREAK, " ");
}

/**
 * Normalises every line break to \n and indents by two spaces each line from
 * `fromLine` on that starts with `URL:`. The default, 1, leaves line 1 as the
 * only address line; 0 fences a text item that must carry none.
 */
export function fenceUrlLines(report: string, fromLine = 1): string {
  return report
    .split(LINE_BREAK)
    .map((line, index) => (index >= fromLine && line.startsWith("URL:") ? `  ${line}` : line))
    .join("\n");
}
