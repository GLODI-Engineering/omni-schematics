/**
 * `JSON.stringify(value, null, 2)`, with one thing added: a number can be asked
 * for in real form.
 *
 * `JSON.stringify` cannot write `48.0`. JavaScript has one number type, the
 * trailing zero is not part of the value, and there is no option, replacer or
 * reviver that puts it back — a replacer returning the *string* `"48.0"` gets
 * `"48.0"` with the quotes. So the writer has to be ours. It is 60 lines
 * because it has to be exact: every other byte it produces must be the byte
 * `JSON.stringify` would have produced, or #268's fix would arrive as a diff on
 * every line of every saved sheet.
 *
 * `json-writer.test.ts` holds it to that, value by value, by comparing against
 * `JSON.stringify` itself with nothing declared real.
 */

/** Where a value sits, from the root: object keys and array indices, in order. */
export type JsonPath = ReadonlyArray<string | number>;

/**
 * Asked at every number. `"real"` writes an integral value with a trailing
 * `.0`; anything else writes what `JSON.stringify` would have written.
 *
 * The array handed in is the writer's own and is reused as it descends, so a
 * caller that wants to keep it must copy it.
 */
export type NumberFormAt = (path: JsonPath) => "real" | "integer" | undefined;

const INDENT = "  ";

/**
 * One number, as JSON.
 *
 * Non-finite is `null`, which is what `JSON.stringify` does with `NaN` and the
 * infinities — a lossy answer, but changing it here would make this writer
 * disagree with every other reader of the format rather than fix anything.
 */
function writeNumber(value: number, form: "real" | "integer" | undefined): string {
  if (!Number.isFinite(value)) return "null";
  const plain = String(value);
  if (form !== "real" || !Number.isInteger(value)) return plain;
  // `String` gives `1e+30` for a large integral double and `48` for a small
  // one. Only the second can take a `.0`; the first is already unambiguously
  // real to every parser, including Python's.
  return /[.eE]/.test(plain) ? plain : `${plain}.0`;
}

export function writeJson(root: unknown, formAt: NumberFormAt): string {
  const path: Array<string | number> = [];

  const write = (value: unknown, indent: string): string | undefined => {
    if (value === null) return "null";
    switch (typeof value) {
      case "boolean":
        return value ? "true" : "false";
      case "number":
        return writeNumber(value, formAt(path));
      case "string":
        return JSON.stringify(value);
      case "undefined":
      case "function":
        // `JSON.stringify` drops such a property from an object and writes
        // `null` for such an array element. Signalled by `undefined` here and
        // handled by the two callers below, which is the only way to tell the
        // two cases apart.
        return undefined;
      case "object":
        break;
      default:
        return undefined;
    }

    const inner = indent + INDENT;
    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      const items = value.map((item, index) => {
        path.push(index);
        const text = write(item, inner);
        path.pop();
        return inner + (text ?? "null");
      });
      return `[\n${items.join(",\n")}\n${indent}]`;
    }

    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record)) {
      path.push(key);
      const text = write(record[key], inner);
      path.pop();
      if (text === undefined) continue;
      parts.push(`${inner}${JSON.stringify(key)}: ${text}`);
    }
    if (parts.length === 0) return "{}";
    return `{\n${parts.join(",\n")}\n${indent}}`;
  };

  // A bare `undefined` at the root is what `JSON.stringify` returns `undefined`
  // for. No document is ever that, and writing "undefined" into a file would be
  // worse than throwing.
  const text = write(root, "");
  if (text === undefined) {
    throw new Error("writeJson: the root value has no JSON form");
  }
  return text;
}
