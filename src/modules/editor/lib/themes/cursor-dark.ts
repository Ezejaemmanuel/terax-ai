import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";

export const cursorDarkTheme = createTheme({
  theme: "dark",
  settings: {
    background: "#181818",
    backgroundImage: "",
    foreground: "#d6d6dd",
    caret: "#d6d6dd",
    selection: "#163761",
    selectionMatch: "rgba(22,55,97,0.45)",
    lineHighlight: "rgba(255,255,255,0.03)",
    gutterBackground: "#181818",
    gutterForeground: "#535353",
    gutterActiveForeground: "#c2c2c2",
    gutterBorder: "transparent",
    fontFamily: "inherit",
  },
  styles: [
    // Comments — gray + italic (distinctive from VSCode's green)
    { tag: t.comment,                color: "#6d6d6d", fontStyle: "italic" },
    { tag: t.lineComment,            color: "#6d6d6d", fontStyle: "italic" },
    { tag: t.blockComment,           color: "#6d6d6d", fontStyle: "italic" },
    { tag: t.docComment,             color: "#6d6d6d", fontStyle: "italic" },

    // Keywords / control flow — teal (NOT blue like VSCode)
    { tag: t.keyword,                color: "#83d6c5" },
    { tag: t.controlKeyword,         color: "#83d6c5" },
    { tag: t.operatorKeyword,        color: "#83d6c5" },
    { tag: t.definitionKeyword,      color: "#82d2ce" },
    { tag: t.moduleKeyword,          color: "#83d6c5" },

    // Storage types (let, const, class, function keyword)
    { tag: t.modifier,               color: "#82d2ce" },

    // Strings — pink/purple (the defining Anysphere characteristic)
    { tag: t.string,                 color: "#e394dc" },
    { tag: t.special(t.string),      color: "#e394dc" },
    { tag: t.regexp,                 color: "#e394dc" },

    // Numbers / constants — yellow-orange
    { tag: t.number,                 color: "#ebc88d" },
    { tag: t.bool,                   color: "#82d2ce" },
    { tag: t.null,                   color: "#82d2ce" },

    // Variables — light blue
    { tag: t.variableName,                          color: "#d6d6dd" },
    { tag: t.local(t.variableName),                 color: "#94c1fa" },
    { tag: t.definition(t.variableName),            color: "#94c1fa" },
    { tag: t.function(t.variableName),              color: "#efb080" },
    { tag: t.definition(t.function(t.variableName)), color: "#efb080" },

    // Properties — purple
    { tag: t.propertyName,           color: "#aa9bf5" },
    { tag: t.function(t.propertyName), color: "#ebc88d" },

    // Types / classes — blue
    { tag: t.typeName,               color: "#87c3ff" },
    { tag: t.className,              color: "#87c3ff" },
    { tag: t.definition(t.typeName), color: "#87c3ff" },
    { tag: t.namespace,              color: "#d1d1d1" },

    // Functions — orange
    { tag: t.function(t.name),       color: "#efb080" },
    { tag: t.name,                   color: "#d6d6dd" },

    // HTML/JSX tags
    { tag: t.tagName,                color: "#87c3ff" },
    { tag: t.attributeName,          color: "#aaa0fa" },
    { tag: t.attributeValue,         color: "#e394dc" },
    { tag: t.angleBracket,           color: "#898989" },

    // Operators & punctuation — neutral foreground
    { tag: t.operator,               color: "#d6d6dd" },
    { tag: t.compareOperator,        color: "#83d6c5" },
    { tag: t.punctuation,            color: "#d6d6dd" },
    { tag: t.separator,              color: "#d6d6dd" },
    { tag: t.bracket,                color: "#d6d6dd" },

    // Decorators — green
    { tag: t.meta,                   color: "#a8cc7c" },
    { tag: t.self,                   color: "#82d2ce" },

    // Markup / markdown
    { tag: t.heading,                color: "#d6d6dd", fontWeight: "bold" },
    { tag: t.emphasis,               fontStyle: "italic" },
    { tag: t.strong,                 fontWeight: "bold" },
    { tag: t.link,                   color: "#83d6c5", textDecoration: "underline" },
    { tag: t.url,                    color: "#83d6c5" },

    { tag: t.invalid,                color: "#f44747" },
  ],
});
