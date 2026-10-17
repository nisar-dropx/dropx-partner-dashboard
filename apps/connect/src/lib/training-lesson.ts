/**
 * Written training lessons: plain text where "## " starts a heading and "- " a bullet; everything else is
 * a paragraph (blank lines separate paragraphs). Same rules in People and DropX One.
 */
export type LessonBlock = { type: "h"; text: string } | { type: "ul"; items: string[] } | { type: "p"; text: string };

export function parseLesson(body: string | null | undefined): LessonBlock[] {
  const blocks: LessonBlock[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ type: "p", text: para.join(" ") }); para = []; } };
  for (const raw of String(body ?? "").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.startsWith("## ")) { flush(); blocks.push({ type: "h", text: line.slice(3).trim() }); continue; }
    if (line.startsWith("- ")) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.type === "ul") last.items.push(line.slice(2).trim()); else blocks.push({ type: "ul", items: [line.slice(2).trim()] });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}
