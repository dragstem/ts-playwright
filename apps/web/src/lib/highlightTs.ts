// Dependency-free, regex-based TypeScript highlighter for the read-only code viewer. Escapes HTML
// first, then wraps comments / strings / keywords / numbers in coloured spans. Good enough for a
// viewer without pulling in CodeMirror; the input is escaped so the output is safe to inject.
const KEYWORDS = [
  "const", "let", "var", "function", "return", "await", "async", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "import", "from", "export", "default", "new",
  "class", "extends", "implements", "type", "interface", "enum", "as", "of", "in", "instanceof",
  "typeof", "null", "undefined", "true", "false", "void", "this", "super", "throw", "try", "catch",
  "finally", "yield", "public", "private", "protected", "readonly", "static", "get", "set"
];

const TOKEN = new RegExp(
  [
    "(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)", // 1: comments
    "(`(?:\\\\.|[^`\\\\])*`|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')", // 2: strings
    `\\b(${KEYWORDS.join("|")})\\b`, // 3: keywords
    "\\b(\\d+(?:\\.\\d+)?)\\b" // 4: numbers
  ].join("|"),
  "g"
);

const COLORS = { comment: "#6a9955", string: "#ce9178", keyword: "#569cd6", number: "#b5cea8" };

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function highlightTs(code: string): string {
  return escapeHtml(code).replace(TOKEN, (match, comment, str, keyword, num) => {
    if (comment) return `<span style="color:${COLORS.comment}">${comment}</span>`;
    if (str) return `<span style="color:${COLORS.string}">${str}</span>`;
    if (keyword) return `<span style="color:${COLORS.keyword}">${keyword}</span>`;
    if (num) return `<span style="color:${COLORS.number}">${num}</span>`;
    return match;
  });
}
