const MAX_DIFF_LINES = 60;

/**
 * Line diff by common-prefix/suffix trimming: what is left in the middle is the
 * change. Recovers a single anchored replacement exactly and degrades to one
 * large middle block for a whole-body rewrite.
 *
 * ponytail: no diff dependency — anchored patches are the only case that needs
 * to read precisely, and trimming gets those exactly right.
 */
export function renderSkillChange(before: string, after: string, context = 3): string {
  if (before === after) return "(no change)";
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let head = 0;
  while (head < beforeLines.length && head < afterLines.length && beforeLines[head] === afterLines[head]) head += 1;
  let tail = 0;
  while (
    tail < beforeLines.length - head
    && tail < afterLines.length - head
    && beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) tail += 1;
  const beforeEnd = beforeLines.length - tail;
  const lines = [
    ...beforeLines.slice(Math.max(0, head - context), head).map((line) => `  ${line}`),
    ...beforeLines.slice(head, beforeEnd).map((line) => `- ${line}`),
    ...afterLines.slice(head, afterLines.length - tail).map((line) => `+ ${line}`),
    ...beforeLines.slice(beforeEnd, beforeEnd + context).map((line) => `  ${line}`),
  ];
  if (lines.length <= MAX_DIFF_LINES) return lines.join("\n");
  return [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more lines`].join("\n");
}
