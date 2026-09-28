// Snippet bodies with tab stops, as the Live Preview Editor script wrote them:
//   ${1:placeholder}  placeholder text, selected after inserting (every ${1:…} / $1: multi-cursor)
//   $1                an empty stop 1
//   ${0:text} / $0    where the cursor ends up (Tab jumps there when stop 1 is selected)
// Other numbers are removed (their placeholder text stays). Pure: bundled into the page world.

/**
 * body → { text, stops: [{ start, end }] (stop 1, offsets into text), final: offset | null }
 */
export function parseSnippetBody(body) {
  const src = typeof body === 'string' ? body : '';
  let text = '';
  const stops = [];
  let final = null;
  let i = 0;
  while (i < src.length) {
    if (src[i] === '$') {
      const rest = src.slice(i);
      const named = /^\$\{(\d+):([^}]*)\}/.exec(rest);
      if (named) {
        const num = Number(named[1]);
        if (num === 1) stops.push({ start: text.length, end: text.length + named[2].length });
        if (num === 0) final = text.length;
        text += named[2];
        i += named[0].length;
        continue;
      }
      const bare = /^\$(\d+)/.exec(rest);
      if (bare) {
        const num = Number(bare[1]);
        if (num === 1) stops.push({ start: text.length, end: text.length });
        if (num === 0) final = text.length;
        i += bare[0].length;
        continue;
      }
    }
    text += src[i];
    i++;
  }
  return { text, stops, final };
}

/** Document position of `offset` into `text` inserted at { row, column }. */
export function offsetToPos(text, offset, at) {
  const lines = text.slice(0, offset).split('\n');
  return lines.length === 1
    ? { row: at.row, column: at.column + lines[0].length }
    : { row: at.row + lines.length - 1, column: lines[lines.length - 1].length };
}
