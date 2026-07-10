// Minimal source-map v3 decoder: resolves a generated position back to the
// original source via the map's `mappings` field. A basic consumer, sufficient
// for the small single-source maps esbuild emits per view — it does not
// interpolate within a segment, special-case unmapped segments, or binary-search.

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < BASE64.length; i++) BASE64_LOOKUP[BASE64[i]] = i;

function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let i = 0;
  while (i < segment.length) {
    let result = 0;
    let shift = 0;
    let continuation: number;
    do {
      const digit = BASE64_LOOKUP[segment[i++]];
      continuation = digit & 32;
      result += (digit & 31) << shift;
      shift += 5;
    } while (continuation);
    values.push(result & 1 ? -(result >>> 1) : result >>> 1);
  }
  return values;
}

interface MappingSegment {
  genLine: number;
  genColumn: number;
  origLine: number;
  origColumn: number;
}

function parseMappings(mapJson: string): MappingSegment[] {
  const map = JSON.parse(mapJson) as { mappings: string };
  const segments: MappingSegment[] = [];
  let origLine = 0;
  let origColumn = 0;
  map.mappings.split(";").forEach((lineMappings, genLine) => {
    if (!lineMappings) return;
    let genColumn = 0;
    for (const part of lineMappings.split(",")) {
      const fields = decodeVlq(part);
      genColumn += fields[0];
      if (fields.length >= 4) {
        origLine += fields[2];
        origColumn += fields[3];
      }
      segments.push({ genLine, genColumn, origLine, origColumn });
    }
  });
  return segments;
}

// Map a generated position (1-based line, 0-based column) to its original
// position in the map's coordinates (both 0-based), falling back to the
// (0-based) generated position when no mapping covers it.
export function mapPosition(
  mapJson: string,
  genLine: number,
  genColumn: number,
): { line: number; column: number } {
  const segments = parseMappings(mapJson);
  const targetLine = genLine - 1; // mappings are 0-based
  let best: MappingSegment | null = null;
  for (const s of segments) {
    if (
      s.genLine < targetLine ||
      (s.genLine === targetLine && s.genColumn <= genColumn)
    ) {
      if (
        !best ||
        s.genLine > best.genLine ||
        (s.genLine === best.genLine && s.genColumn > best.genColumn)
      )
        best = s;
    }
  }
  if (!best) return { line: targetLine, column: genColumn };
  return { line: best.origLine, column: best.origColumn };
}
